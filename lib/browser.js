// @ts-check
// The browser a session shares with its user: one headless Chromium per
// session, driven by the agent through Playwright and by a client through
// /api/v1, on the same tabs at the same time.
//
// The server launches it so it outlives every turn. The agent's Playwright MCP
// server connects via --cdp-endpoint; this module holds its own CDP connection
// (Node's built-in WebSocket, no dependency) for the screencast and input.
//
// The profile lives on disk as long as the session, so logins survive a
// reopen and a server restart.

import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getConfig } from './config.js';

// 1280 wide matches the QA videos, so the view looks like what a run records.
const WINDOW = { width: 1280, height: 800 };
// Minimum gap between frame acks. Chromium waits for the ack before the next
// frame, so this caps the stream at ten frames a second.
const FRAME_MS = 100;
const LAUNCH_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 15_000;

// Pinned, since a release renaming its tools would silently change what the
// agent is told it can do.
export const PLAYWRIGHT_MCP_PACKAGE = '@playwright/mcp@0.0.83';

/**
 * @typedef {{ id: string, url: string, title: string }} Tab
 * @typedef {{ data: string, width: number, height: number, tab: string }} Frame
 * @typedef {{ type: 'frame', frame: Frame } | { type: 'tabs', tabs: Tab[], active: string|null } | { type: 'closed' }} BrowserEvent
 * @typedef {{
 *   id: string,
 *   proc: import('child_process').ChildProcess,
 *   endpoint: string,
 *   cdp: Cdp,
 *   pages: Map<string, Tab>,
 *   active: string|null,
 *   attached: Map<string, Promise<string>>,
 *   watchers: Set<(e: BrowserEvent) => void>,
 *   frame: Frame|null,
 *   casting: string|null,
 *   castSession: string|null,
 *   castChain: Promise<void>,
 *   lastAck: number,
 *   stopped: boolean,
 *   titleTimer: NodeJS.Timeout|null,
 * }} Browser
 */

/** @type {Map<string, Browser>} */
const browsers = new Map();
/** @type {Map<string, Promise<Browser>>} */
const starting = new Map();
// In-flight launches; one cancelled by a stop or forget shuts its browser
// instead of registering it, since nothing would stop it otherwise.
/** @type {Map<string, { cancelled: boolean, forget: boolean }>} */
const launches = new Map();
// Browsers told to close and not gone yet: out of `browsers` so a start gets a
// fresh one, but still reachable by shutdown.
/** @type {Set<Browser>} */
const closing = new Set();

// Called when a session's browser comes up or goes away. Set by jobs.js, which
// imports this module (so this one cannot import it).
let changed = (/** @type {string} */ _id) => {};
/** @param {(id: string) => void} fn */
export function onBrowserChange(fn) {
  changed = fn;
}

const fail = (status, message) => Object.assign(new Error(message), { status });

// ---------------------------------------------------------------------------
// Finding Chromium
// ---------------------------------------------------------------------------

/** @type {string|null|undefined} */
let foundBin;

// BROWSER_BIN, else the newest Playwright-downloaded Chromium (QA runs install
// it), else whatever Chromium or Chrome is on PATH.
export function findBrowserBin() {
  const configured = getConfig().browserBin;
  if (configured) return configured;
  if (foundBin !== undefined) return foundBin;
  foundBin = null;
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  try {
    const builds = fs
      .readdirSync(cache)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const build of builds) {
      for (const sub of fs.readdirSync(path.join(cache, build))) {
        const bin = path.join(cache, build, sub, 'chrome');
        if (sub.startsWith('chrome-linux') && fs.existsSync(bin)) return (foundBin = bin);
      }
    }
  } catch {
    // No Playwright cache: fall through to PATH.
  }
  for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
    try {
      const bin = execFileSync('which', [name], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (bin) return (foundBin = bin);
    } catch {
      // Not this one.
    }
  }
  return foundBin;
}

// Under the OS temp dir: a cache of logins and cookies, never worth backing up.
export function profileDir(id) {
  return path.join(os.tmpdir(), 'briareus-browser', id.replace(/[^\w-]/g, '_'));
}

// The Playwright MCP server's snapshots and screenshots, beside the profile.
export function browserOutputDir(id) {
  return `${profileDir(id)}-output`;
}

// ---------------------------------------------------------------------------
// The DevTools connection
// ---------------------------------------------------------------------------

// One WebSocket to the browser, with each page reached as a flattened session
// (the `sessionId` on a message) so one connection follows every tab.
class Cdp {
  /** @param {string} url */
  constructor(url) {
    this.url = url;
    this.next = 0;
    /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, timer: NodeJS.Timeout }>} */
    this.pending = new Map();
    /** @type {(msg: { method: string, params: any, sessionId?: string }) => void} */
    this.onEvent = () => {};
    this.onClose = () => {};
    /** @type {WebSocket|null} */
    this.ws = null;
  }

  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => resolve(undefined);
      ws.onerror = () => reject(new Error('Could not connect to the browser'));
      ws.onclose = () => {
        for (const { reject: fail, timer } of this.pending.values()) {
          clearTimeout(timer);
          fail(new Error('The browser went away'));
        }
        this.pending.clear();
        this.onClose();
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data));
        if (msg.id == null) return this.onEvent(msg);
        const call = this.pending.get(msg.id);
        if (!call) return;
        this.pending.delete(msg.id);
        clearTimeout(call.timer);
        if (msg.error) call.reject(new Error(msg.error.message || 'The browser refused that'));
        else call.resolve(msg.result);
      };
    });
  }

  /**
   * @param {string} method
   * @param {object} [params]
   * @param {string|null} [sessionId]
   * @returns {Promise<any>}
   */
  send(method, params = {}, sessionId = null) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('The browser went away'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The browser did not answer ${method}`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // Already gone.
    }
  }
}

// ---------------------------------------------------------------------------
// Starting and stopping
// ---------------------------------------------------------------------------

/** @param {string} id */
export function browserRunning(id) {
  const b = browsers.get(id);
  return !!b && !b.stopped;
}

// The address the agent's Playwright connects to, or null. Loopback only: a
// debugging port is a remote control for the whole browser.
/** @param {string} id */
export function browserEndpoint(id) {
  const b = browsers.get(id);
  return b && !b.stopped ? b.endpoint : null;
}

// Kills an orphaned Chromium (left by a server killed outright) still using
// this profile. Headless Chromium takes no profile lock, so two would corrupt
// it. Found via /proc command lines; Linux only, a no-op elsewhere.
/** @param {string} dir */
export function releaseProfile(dir) {
  const flag = `--user-data-dir=${dir}`;
  /** @type {string[]} */
  let pids;
  try {
    pids = fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p));
  } catch {
    return;
  }
  for (const pid of pids) {
    try {
      // Chromium rewrites its process title, so arguments may be space-joined.
      const words = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split(/[\0 ]/);
      // Only the main process; helpers carry --type= and die with it.
      if (words.includes(flag) && !words.some((w) => w.startsWith('--type=')))
        process.kill(Number(pid), 'SIGKILL');
    } catch {
      // Gone already, or not ours to read.
    }
  }
  // A headed Chromium on the profile would have left these; harmless when absent.
  for (const lock of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    fs.rmSync(path.join(dir, lock), { force: true });
  }
}

/**
 * @param {string} id
 * @returns {Promise<Browser>}
 */
export function startBrowser(id) {
  const running = browsers.get(id);
  if (running && !running.stopped) return Promise.resolve(running);
  const already = starting.get(id);
  if (already) return already;
  const launch = launchBrowser(id).finally(() => starting.delete(id));
  starting.set(id, launch);
  return launch;
}

/** @param {string} id */
async function launchBrowser(id) {
  const bin = findBrowserBin();
  if (!bin)
    throw fail(
      503,
      'No Chromium on this server: run `npx playwright install chromium`, or set BROWSER_BIN in .env',
    );
  const ticket = { cancelled: false, forget: false };
  launches.set(id, ticket);
  try {
    return await launchOn(id, bin, ticket);
  } finally {
    if (launches.get(id) === ticket) launches.delete(id);
  }
}

/**
 * @param {string} id
 * @param {string} bin
 * @param {{ cancelled: boolean, forget: boolean }} ticket
 */
async function launchOn(id, bin, ticket) {
  const dir = profileDir(id);
  fs.mkdirSync(dir, { recursive: true });
  releaseProfile(dir);
  const proc = spawn(
    bin,
    [
      '--headless=new',
      // As Playwright does: most Ubuntu installs disable unprivileged user
      // namespaces, without which a sandboxed Chromium will not start.
      '--no-sandbox',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      `--user-data-dir=${dir}`,
      // Otherwise cookies go through the OS keyring, which a server has no
      // unlocked session for, and every navigation hangs.
      '--password-store=basic',
      '--use-mock-keychain',
      // A tab out of view is still the agent's to drive, so no throttling.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      // No background updates, sync or crash uploads phoning home.
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--disable-breakpad',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      `--window-size=${WINDOW.width},${WINDOW.height}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const wsUrl = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('The browser did not start in time'));
    }, LAUNCH_TIMEOUT_MS);
    proc.stderr?.on('data', (chunk) => {
      output = (output + chunk).slice(-8000);
      const m = output.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Could not start the browser: ${e.message}`));
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      const last = output.trim().split('\n').slice(-1)[0] || '';
      reject(new Error(`The browser exited before it was ready (${code})${last ? `: ${last}` : ''}`));
    });
  });
  // Keep draining stderr, or Chromium blocks once the pipe fills.
  proc.stderr?.resume();

  const cdp = new Cdp(wsUrl);
  /** @type {Browser} */
  const b = {
    id,
    proc,
    endpoint: `http://127.0.0.1:${new URL(wsUrl).port}`,
    cdp,
    pages: new Map(),
    active: null,
    attached: new Map(),
    watchers: new Set(),
    frame: null,
    casting: null,
    castSession: null,
    castChain: Promise.resolve(),
    lastAck: 0,
    stopped: false,
    titleTimer: null,
  };
  cdp.onEvent = (msg) => onCdpEvent(b, msg);
  cdp.onClose = () => gone(b);
  proc.on('exit', () => gone(b));
  try {
    await cdp.open();
    await cdp.send('Target.setDiscoverTargets', { discover: true });
  } catch (e) {
    proc.kill('SIGKILL');
    throw e;
  }
  if (ticket.cancelled) {
    b.stopped = true;
    cdp.close();
    proc.kill('SIGKILL');
    if (ticket.forget) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(browserOutputDir(id), { recursive: true, force: true });
    }
    throw fail(409, 'The browser was stopped while it was starting');
  }
  browsers.set(id, b);
  changed(id);
  return b;
}

// The browser ended, by a stop or on its own: tell watchers and the session.
/** @param {Browser} b */
function gone(b) {
  if (b.stopped) return;
  b.stopped = true;
  b.cdp.close();
  if (b.proc.exitCode === null) b.proc.kill('SIGKILL');
  if (browsers.get(b.id) === b) browsers.delete(b.id);
  closing.delete(b);
  for (const watch of b.watchers) watch({ type: 'closed' });
  b.watchers.clear();
  changed(b.id);
}

/** @param {string} id */
export function stopBrowser(id) {
  const launch = launches.get(id);
  if (launch) launch.cancelled = true;
  const b = browsers.get(id);
  if (!b) return;
  browsers.delete(id);
  closing.add(b);
  changed(id);
  // A clean exit first so cookies are written; gone() kills one that hangs.
  b.cdp.send('Browser.close').catch(() => {});
  setTimeout(() => gone(b), 2000).unref();
}

// Stop the browser and drop its profile: for a session that is deleted.
/** @param {string} id */
export function forgetBrowser(id) {
  const launch = launches.get(id);
  if (launch) Object.assign(launch, { cancelled: true, forget: true });
  const b = browsers.get(id);
  if (b) gone(b);
  fs.rmSync(profileDir(id), { recursive: true, force: true });
  fs.rmSync(browserOutputDir(id), { recursive: true, force: true });
}

// On shutdown: synchronous, since the process is about to exit.
export function stopAllBrowsers() {
  for (const b of [...browsers.values(), ...closing]) gone(b);
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

/** @param {Browser} b */
function tabList(b) {
  return [...b.pages.values()];
}

/** @param {Browser} b */
function announceTabs(b) {
  const event = /** @type {BrowserEvent} */ ({ type: 'tabs', tabs: tabList(b), active: b.active });
  for (const watch of b.watchers) watch(event);
}

/**
 * @param {Browser} b
 * @param {{ method: string, params: any, sessionId?: string }} msg
 */
function onCdpEvent(b, msg) {
  const { method, params } = msg;
  if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
    const info = params.targetInfo;
    if (info.type !== 'page') return;
    const known = b.pages.has(info.targetId);
    b.pages.set(info.targetId, { id: info.targetId, url: info.url, title: info.title });
    // The view follows a newly opened tab (a link in a new tab, a popup).
    if (!known) setActive(b, info.targetId);
    else announceTabs(b);
    refreshTitles(b);
    return;
  }
  if (method === 'Page.loadEventFired') {
    refreshTitles(b);
    return;
  }
  if (method === 'Target.targetDestroyed') {
    if (!b.pages.delete(params.targetId)) return;
    b.attached.delete(params.targetId);
    if (b.active === params.targetId) setActive(b, tabList(b).at(-1)?.id || null);
    else announceTabs(b);
    return;
  }
  if (method === 'Target.detachedFromTarget') {
    for (const [target, session] of b.attached) {
      session.then(
        (s) => s === params.sessionId && b.attached.get(target) === session && b.attached.delete(target),
        () => {},
      );
    }
    return;
  }
  if (method === 'Page.screencastFrame' && msg.sessionId && msg.sessionId === b.castSession) {
    const { data, metadata, sessionId: frameId } = params;
    b.frame = {
      data,
      width: Math.round(metadata.deviceWidth),
      height: Math.round(metadata.deviceHeight),
      tab: /** @type {string} */ (b.casting),
    };
    const event = /** @type {BrowserEvent} */ ({ type: 'frame', frame: b.frame });
    for (const watch of b.watchers) watch(event);
    const castSession = b.castSession;
    const wait = Math.max(0, b.lastAck + FRAME_MS - Date.now());
    setTimeout(() => {
      b.lastAck = Date.now();
      if (b.castSession === castSession)
        b.cdp.send('Page.screencastFrameAck', { sessionId: frameId }, castSession).catch(() => {});
    }, wait).unref();
  }
}

// Chromium reports a navigation before the <title> exists and does not always
// report it later, so titles are re-read shortly after.
/** @param {Browser} b */
function refreshTitles(b) {
  if (b.titleTimer) return;
  b.titleTimer = setTimeout(async () => {
    b.titleTimer = null;
    if (b.stopped) return;
    try {
      const { targetInfos } = await b.cdp.send('Target.getTargets');
      let moved = false;
      for (const info of targetInfos) {
        const tab = b.pages.get(info.targetId);
        if (tab && (tab.title !== info.title || tab.url !== info.url)) {
          b.pages.set(info.targetId, { id: info.targetId, url: info.url, title: info.title });
          moved = true;
        }
      }
      if (moved) announceTabs(b);
    } catch {
      // The browser went away; gone() tells everyone.
    }
  }, 500);
  b.titleTimer.unref();
}

/**
 * @param {Browser} b
 * @param {string|null} target
 */
function setActive(b, target) {
  b.active = target;
  announceTabs(b);
  recast(b);
}

// A page's flattened session, attached once and kept until the page goes.
/**
 * @param {Browser} b
 * @param {string} target
 * @returns {Promise<string>}
 */
function attach(b, target) {
  let session = b.attached.get(target);
  if (!session) {
    session = b.cdp.send('Target.attachToTarget', { targetId: target, flatten: true }).then(async (r) => {
      const id = /** @type {string} */ (r.sessionId);
      await b.cdp.send('Page.enable', {}, id);
      return id;
    });
    session.catch(() => b.attached.delete(target));
    b.attached.set(target, session);
  }
  return session;
}

// Screencast the tab in view only while somebody watches, to save CPU. Changes
// are chained so a quick tab switch cannot leave two casts running.
/** @param {Browser} b */
function recast(b) {
  b.castChain = b.castChain
    .then(async () => {
      const want = b.watchers.size && !b.stopped ? b.active : null;
      if (want === b.casting) return;
      if (b.castSession) await b.cdp.send('Page.stopScreencast', {}, b.castSession).catch(() => {});
      b.casting = null;
      b.castSession = null;
      if (!want) return;
      const session = await attach(b, want);
      b.casting = want;
      b.castSession = session;
      await b.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, everyNthFrame: 1 }, session);
    })
    .catch(() => {
      b.casting = null;
      b.castSession = null;
    });
}

// ---------------------------------------------------------------------------
// What a client reads and does
// ---------------------------------------------------------------------------

/** @param {string} id */
export function browserState(id) {
  const b = browsers.get(id);
  if (!b || b.stopped) return { running: false, tabs: [], active: null };
  return { running: true, tabs: tabList(b), active: b.active };
}

// Sends the tabs and last frame at once, then every change until closed.
/**
 * @param {string} id
 * @param {(e: BrowserEvent) => void} listener
 * @returns {() => void} unsubscribe
 */
export function watchBrowser(id, listener) {
  const b = browsers.get(id);
  if (!b || b.stopped) throw fail(409, 'The session’s browser is not running');
  listener({ type: 'tabs', tabs: tabList(b), active: b.active });
  if (b.frame && b.frame.tab === b.active) listener({ type: 'frame', frame: b.frame });
  b.watchers.add(listener);
  recast(b);
  return () => {
    b.watchers.delete(listener);
    recast(b);
  };
}

/** @param {string} id */
export async function browserScreenshot(id) {
  const b = live(id);
  const session = await attach(b, activeTab(b));
  const { data } = await b.cdp.send('Page.captureScreenshot', { format: 'png' }, session);
  return Buffer.from(data, 'base64');
}

/** @param {string} id */
function live(id) {
  const b = browsers.get(id);
  if (!b || b.stopped) throw fail(409, 'The session’s browser is not running');
  return b;
}

/** @param {Browser} b */
function activeTab(b) {
  if (!b.active) throw fail(409, 'The browser has no tab open');
  return b.active;
}

// Named keys, with the virtual key code and text Chromium needs to act on them.
/** @type {Record<string, { code: string, keyCode: number, text?: string }>} */
const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  Escape: { code: 'Escape', keyCode: 27 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  ' ': { code: 'Space', keyCode: 32, text: ' ' },
};
const MODIFIER_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
const BUTTONS = new Set(['left', 'right', 'middle']);

// What a key means to Chromium: a named one from KEYS, or a single character.
/** @param {string} key */
export function keyDefinition(key) {
  if (KEYS[key]) return { key, ...KEYS[key] };
  if (typeof key === 'string' && [...key].length === 1) {
    const upper = key.toUpperCase();
    const letter = /^[A-Z]$/.test(upper);
    const digit = /^[0-9]$/.test(key);
    return {
      key,
      code: letter ? `Key${upper}` : digit ? `Digit${key}` : '',
      keyCode: letter || digit ? upper.charCodeAt(0) : 0,
      text: key,
    };
  }
  throw fail(
    400,
    `Unknown key \`${key}\`: send a single character or one of ${Object.keys(KEYS).join(', ')}`,
  );
}

/** @param {any} v @param {string} name */
function coord(v, name) {
  const n = Number(v);
  if (v == null || v === '' || !Number.isFinite(n)) throw fail(400, `\`${name}\` must be a number`);
  return n;
}

// Web URLs only, so a client cannot reach the server's files or chrome:// pages.
/** @param {any} url */
export function checkUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw fail(400, '`url` must be an absolute http or https URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) && parsed.href !== 'about:blank')
    throw fail(400, '`url` must be an absolute http or https URL');
  return parsed.href;
}

// One client action. Coordinates are CSS pixels of the viewport, the frame's
// `width` × `height`; a client showing it at another size must scale.
/**
 * @param {string} id
 * @param {any} action
 */
export async function browserInput(id, action) {
  const b = live(id);
  const type = action && action.type;
  const send = (/** @type {string} */ method, /** @type {object} */ params = {}, session = null) =>
    b.cdp.send(method, params, session);
  const modifiers = (Array.isArray(action.modifiers) ? action.modifiers : []).reduce((bits, m) => {
    if (!(m in MODIFIER_BITS)) throw fail(400, `Unknown modifier \`${m}\`: alt, ctrl, meta or shift`);
    return bits | MODIFIER_BITS[m];
  }, 0);

  switch (type) {
    case 'click':
    case 'down':
    case 'up':
    case 'move': {
      const session = await attach(b, activeTab(b));
      const x = coord(action.x, 'x');
      const y = coord(action.y, 'y');
      const button = action.button ?? 'left';
      if (!BUTTONS.has(button)) throw fail(400, '`button` must be left, right or middle');
      const clickCount = Math.max(1, Math.min(3, Number(action.clickCount) || 1));
      const mouse = (/** @type {string} */ kind, /** @type {object} */ extra = {}) =>
        send('Input.dispatchMouseEvent', { type: kind, x, y, modifiers, ...extra }, session);
      if (type === 'move') return mouse('mouseMoved', { button: action.button ? button : 'none' });
      if (type !== 'up') {
        if (type === 'click') await mouse('mouseMoved');
        await mouse('mousePressed', { button, clickCount });
      }
      if (type !== 'down') await mouse('mouseReleased', { button, clickCount });
      return;
    }
    case 'wheel': {
      const session = await attach(b, activeTab(b));
      return send(
        'Input.dispatchMouseEvent',
        {
          type: 'mouseWheel',
          x: coord(action.x, 'x'),
          y: coord(action.y, 'y'),
          deltaX: Number(action.deltaX) || 0,
          deltaY: Number(action.deltaY) || 0,
          modifiers,
        },
        session,
      );
    }
    case 'type': {
      if (typeof action.text !== 'string' || !action.text) throw fail(400, '`text` must be some text');
      if (action.text.length > 10_000) throw fail(400, '`text` is limited to 10,000 characters');
      return send('Input.insertText', { text: action.text }, await attach(b, activeTab(b)));
    }
    case 'key': {
      const session = await attach(b, activeTab(b));
      const def = keyDefinition(action.key);
      // With ctrl, alt or meta it is a shortcut; sending text would also type it.
      const text = modifiers & ~MODIFIER_BITS.shift ? undefined : def.text;
      const common = {
        key: def.key,
        code: def.code,
        windowsVirtualKeyCode: def.keyCode,
        nativeVirtualKeyCode: def.keyCode,
        modifiers,
      };
      await send(
        'Input.dispatchKeyEvent',
        { type: text ? 'keyDown' : 'rawKeyDown', text, ...common },
        session,
      );
      return send('Input.dispatchKeyEvent', { type: 'keyUp', ...common }, session);
    }
    case 'navigate': {
      const url = checkUrl(action.url);
      return send('Page.navigate', { url }, await attach(b, activeTab(b)));
    }
    case 'back':
    case 'forward': {
      const session = await attach(b, activeTab(b));
      const { currentIndex, entries } = await send('Page.getNavigationHistory', {}, session);
      const entry = entries[currentIndex + (type === 'back' ? -1 : 1)];
      if (!entry) return;
      return send('Page.navigateToHistoryEntry', { entryId: entry.id }, session);
    }
    case 'reload':
      return send('Page.reload', {}, await attach(b, activeTab(b)));
    case 'tab': {
      if (!b.pages.has(action.tab)) throw fail(404, 'No such tab');
      await send('Target.activateTarget', { targetId: action.tab });
      setActive(b, action.tab);
      return;
    }
    case 'newTab': {
      const url = action.url ? checkUrl(action.url) : 'about:blank';
      await send('Target.createTarget', { url });
      return;
    }
    case 'closeTab': {
      const tab = action.tab ?? b.active;
      if (!b.pages.has(tab)) throw fail(404, 'No such tab');
      await send('Target.closeTarget', { targetId: tab });
      return;
    }
    default:
      throw fail(
        400,
        '`type` must be one of click, down, up, move, wheel, type, key, navigate, back, forward, reload, tab, newTab, closeTab',
      );
  }
}
