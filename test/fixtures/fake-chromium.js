#!/usr/bin/env node
// A stand-in for Chromium that lib/browser.js can launch: it announces a DevTools endpoint on
// stderr as Chromium does and answers CDP over a WebSocket with a small model of tabs.
//
// Tests reach it on the same endpoint: `Test.calls` returns the module's calls, `Test.emit`
// sends an event to every other connection, and `Test.hang` stops answering a method.
//
// FAKE_CHROMIUM_MODE=exit makes it die before it is ready; `idle` makes it just hold a profile.

import crypto from 'crypto';
import http from 'http';

const mode = process.env.FAKE_CHROMIUM_MODE || '';
if (mode === 'exit') {
  process.stderr.write('[fake] cannot open display\n');
  process.exit(3);
}
if (mode === 'idle') {
  setInterval(() => {}, 1000);
} else {
  serve();
}

function serve() {
  const clients = new Set();
  const calls = [];
  const hanging = new Set();
  /** @type {Map<string, { targetId: string, type: string, url: string, title: string }>} */
  const pages = new Map([['T1', { targetId: 'T1', type: 'page', url: 'about:blank', title: 'about:blank' }]]);
  let nextTarget = 2;

  const server = http.createServer((_req, res) => res.end());
  server.on('upgrade', (req, socket) => {
    const accept = crypto
      .createHash('sha1')
      .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const client = { socket, send: (msg) => socket.write(frame(JSON.stringify(msg))) };
    clients.add(client);
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const parsed = unframe(buf);
        if (!parsed) break;
        buf = buf.subarray(parsed.used);
        if (parsed.opcode === 8) {
          socket.end(Buffer.from([0x88, 0]));
          return;
        }
        if (parsed.opcode === 1) handle(client, JSON.parse(parsed.payload.toString('utf8')));
      }
    });
    socket.on('close', () => clients.delete(client));
    socket.on('error', () => clients.delete(client));
  });
  server.listen(0, '127.0.0.1', () => {
    process.stderr.write(
      `\nDevTools listening on ws://127.0.0.1:${server.address().port}/devtools/browser/fake\n`,
    );
  });

  const everyone = (msg, except = null) => {
    for (const c of clients) if (c !== except) c.send(msg);
  };
  const info = (page) => ({ ...page, attached: false });

  function handle(client, { id, method, params = {}, sessionId }) {
    const reply = (result) => client.send({ id, result, ...(sessionId ? { sessionId } : {}) });
    const event = (name, data, session = sessionId) =>
      client.send({ method: name, params: data, ...(session ? { sessionId: session } : {}) });
    if (method === 'Test.calls') return reply({ calls });
    if (method === 'Test.emit') {
      everyone(params.message, client);
      return reply({});
    }
    if (method === 'Test.hang') {
      hanging.add(params.method);
      return reply({});
    }
    if (method === 'Test.setTitle') {
      const page = pages.get(params.targetId);
      if (page) page.title = params.title;
      return reply({});
    }
    calls.push({ method, params, sessionId: sessionId || null });
    if (hanging.has(method)) return;
    switch (method) {
      case 'Target.setDiscoverTargets':
        reply({});
        for (const page of pages.values()) event('Target.targetCreated', { targetInfo: info(page) }, null);
        return;
      case 'Target.attachToTarget':
        if (!pages.has(params.targetId))
          return client.send({ id, error: { message: 'No target with given id' } });
        return reply({ sessionId: `S-${params.targetId}` });
      case 'Page.startScreencast':
        reply({});
        return event('Page.screencastFrame', {
          data: Buffer.from(`frame of ${sessionId}`).toString('base64'),
          metadata: { deviceWidth: 1280, deviceHeight: 657.4, pageScaleFactor: 1 },
          sessionId: 7,
        });
      case 'Page.captureScreenshot':
        return reply({ data: Buffer.from('PNGDATA').toString('base64') });
      case 'Page.getNavigationHistory':
        return reply({ currentIndex: 1, entries: [{ id: 10 }, { id: 11 }, { id: 12 }] });
      case 'Page.navigate': {
        const page = pages.get(String(sessionId).replace(/^S-/, ''));
        if (page) {
          page.url = params.url;
          everyone({ method: 'Target.targetInfoChanged', params: { targetInfo: info(page) } });
        }
        return reply({ frameId: 'F1' });
      }
      case 'Target.createTarget': {
        const targetId = `T${nextTarget++}`;
        const page = { targetId, type: 'page', url: params.url, title: params.url };
        pages.set(targetId, page);
        reply({ targetId });
        return everyone({ method: 'Target.targetCreated', params: { targetInfo: info(page) } });
      }
      case 'Target.closeTarget':
        pages.delete(params.targetId);
        reply({ success: true });
        return everyone({ method: 'Target.targetDestroyed', params: { targetId: params.targetId } });
      case 'Target.getTargets':
        return reply({ targetInfos: [...pages.values()].map(info) });
      case 'Browser.close':
        reply({});
        setTimeout(() => process.exit(0), 20);
        return;
      default:
        return reply({});
    }
  }
}

// The two halves of RFC 6455 a CDP connection uses: unmasked text frames out,
// masked frames in.
function frame(text) {
  const payload = Buffer.from(text);
  const len = payload.length;
  const head =
    len < 126
      ? Buffer.from([0x81, len])
      : len < 65536
        ? Buffer.from([0x81, 126, len >> 8, len & 255])
        : Buffer.concat([Buffer.from([0x81, 127]), bigLength(len)]);
  return Buffer.concat([head, payload]);
}

function bigLength(len) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(len));
  return b;
}

function unframe(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 15;
  const masked = (buf[1] & 128) !== 0;
  let len = buf[1] & 127;
  let at = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    at = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    at = 10;
  }
  const mask = masked ? buf.subarray(at, at + 4) : null;
  if (masked) at += 4;
  if (buf.length < at + len) return null;
  const payload = Buffer.from(buf.subarray(at, at + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return { opcode, payload, used: at + len };
}
