import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

// Each test gets a scratch videos directory of its own, so the module-level
// manifest on disk never leaks state between tests.
const cfgState = vi.hoisted(() => ({ testVideosDir: '', r2: null }));
vi.mock('../lib/config.js', () => ({
  getConfig: () => ({ testVideosDir: cfgState.testVideosDir, r2: cfgState.r2 }),
}));

import { syncVideos } from '../lib/r2.js';

const R2 = {
  endpoint: 'https://acct.r2.cloudflarestorage.com',
  accessKeyId: 'AKID',
  secretAccessKey: 'SECRET',
  bucket: 'qa-videos',
  publicBaseUrl: 'https://videos.example.com',
};

const RUN = 'acme__shop/pr-<pr-number>-0123456789abcdef0123456789abcdef';
let fetchMock;

beforeEach(() => {
  cfgState.testVideosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-test-'));
  cfgState.r2 = { ...R2 };
  fetchMock = vi.fn(async () => ({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(cfgState.testVideosDir, { recursive: true, force: true });
});

function drop(rel, content = 'webm-bytes') {
  const file = path.join(cfgState.testVideosDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('syncVideos', () => {
  it('isolates two projects and two sessions on the same project, including retries and bytes', async () => {
    const otherRun = 'other__app/pr-<pr-number>-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const siblingRun = 'acme__shop/pr-<pr-number>-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const ownFile = 'acme__shop/pr-12-0123456789abcdef0123456789abcdef/1-login.webm';
    const otherFile = 'other__app/pr-34-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/2-checkout.webm';
    drop(ownFile, 'owner bytes');
    drop(otherFile, 'other project bytes');
    drop('acme__shop/pr-56-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/3-sibling.webm', 'sibling bytes');
    drop('acme__shop/pr-12-0123456789abcdef0123456789abcdef/private.pdf', 'not a video');
    const sent = [];
    fetchMock.mockImplementation(async (url, opts) => {
      const bytes = Buffer.from(await new Response(opts.body).arrayBuffer());
      sent.push({ url: String(url), bytes: bytes.toString() });
      if (String(url).includes('/pr-12-') && sent.length === 1) throw new TypeError('fetch failed');
      return { ok: true };
    });
    // Queue both before either starts: sharing a global queued result used to
    // attach the first project's transport error to the second session too.
    const owner = syncVideos([RUN]);
    const other = syncVideos([otherRun]);
    expect(other).not.toBe(owner);
    expect(await owner).toEqual({
      uploaded: [],
      failed: [{ file: ownFile, error: 'fetch failed' }],
      deferred: 0,
    });
    expect(await other).toEqual({ uploaded: [otherFile], failed: [], deferred: 0 });
    expect(await syncVideos([otherRun])).toEqual({ uploaded: [], failed: [], deferred: 0 });
    expect(sent).toHaveLength(2);
    expect(fs.readFileSync(path.join(cfgState.testVideosDir, ownFile), 'utf8')).toBe('owner bytes');
    expect(await syncVideos([RUN])).toEqual({ uploaded: [ownFile], failed: [], deferred: 0 });
    expect(sent.map((s) => s.bytes)).toEqual(['owner bytes', 'other project bytes', 'owner bytes']);
    expect(sent.every((s) => s.url.startsWith(`${R2.endpoint}/${R2.bucket}/`))).toBe(true);
    expect(await syncVideos([siblingRun])).toMatchObject({
      failed: [],
      uploaded: [expect.stringContaining('/pr-56-')],
    });
    expect(await syncVideos()).toEqual({ uploaded: [], failed: [], deferred: 0 });
    expect(await syncVideos([RUN])).toEqual({ uploaded: [], failed: [], deferred: 0 });
    expect(sent).toHaveLength(4);
  });

  it.each([false, true])('skips the queue for published owners (signal=%s)', async (withSignal) => {
    const ownFile = 'acme__shop/pr-12-0123456789abcdef0123456789abcdef/login.webm';
    const otherRun = 'other__app/pr-<pr-number>-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    drop(ownFile);
    await syncVideos([RUN]);
    drop('other__app/pr-34-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/login.webm');
    let release;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true });
        }),
    );
    const other = syncVideos([otherRun]);
    try {
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      const signal = withSignal ? new AbortController().signal : undefined;
      expect(await Promise.race([syncVideos([RUN], signal), Promise.resolve('queued')])).toEqual({
        uploaded: [],
        failed: [],
        deferred: 0,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      release();
      await other;
    }
  });

  it('bounds queued owners from enqueue time and skips already published files', async () => {
    const otherRun = 'other__app/pr-<pr-number>-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const otherFile = 'other__app/pr-34-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/login.webm';
    const ownFile = 'acme__shop/pr-12-0123456789abcdef0123456789abcdef/login.webm';
    drop(ownFile);
    await syncVideos([RUN]);
    drop(otherFile);
    let release;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true });
        }),
    );
    const first = syncVideos([otherRun]);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    vi.useFakeTimers();
    try {
      const unchanged = syncVideos([RUN]);
      const pendingRun = 'third__app/pr-<pr-number>-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      drop('third__app/pr-56-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/login.webm');
      const pending = syncVideos([pendingRun]);
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(await unchanged).toEqual({ uploaded: [], failed: [], deferred: 0 });
      expect(await pending).toEqual({ uploaded: [], failed: [], deferred: 1 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      release();
      await first;
      // Drain the expired passes, which must not publish after their caller left.
      expect((await syncVideos([RUN])).uploaded).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect((await syncVideos([pendingRun])).uploaded).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])('cancels publication while queued or uploading (active=%s)', async (active) => {
    const ownFile = 'acme__shop/pr-12-0123456789abcdef0123456789abcdef/login.webm';
    const otherRun = 'other__app/pr-<pr-number>-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    drop(ownFile);
    drop('other__app/pr-34-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/login.webm');
    let release;
    fetchMock.mockImplementationOnce(
      (_url, opts) =>
        new Promise((resolve, reject) => {
          release = () => resolve({ ok: true });
          opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
        }),
    );
    const controller = new AbortController();
    const first = active ? syncVideos([RUN], controller.signal) : syncVideos([otherRun]);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const canceled = active ? first : syncVideos([RUN], controller.signal);
    controller.abort();
    expect(await canceled).toEqual(
      active
        ? { uploaded: [], failed: [{ file: ownFile, error: 'This operation was aborted' }], deferred: 0 }
        : { uploaded: [], failed: [], deferred: 1 },
    );
    if (!active) release();
    await first;
    expect((await syncVideos([RUN])).uploaded).toEqual([ownFile]);
  });

  it.each(['deadline', 'cancel'])('preserves active results after %s', async (reason) => {
    const files = ['1-success', '2-denied', '3-timeout', '4-stalled', '5-deferred'].map(
      (name) => `acme__shop/pr-12-0123456789abcdef0123456789abcdef/${name}.webm`,
    );
    for (const file of files) drop(file);
    let uploading = false;
    fetchMock
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, status: 403, text: async () => 'AccessDenied' })
      .mockRejectedValueOnce(new TypeError('fetch failed', { cause: { code: 'ETIMEDOUT' } }))
      .mockImplementationOnce(
        (_url, opts) =>
          new Promise((_resolve, reject) => {
            uploading = true;
            opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
          }),
      );
    const controller = new AbortController();
    vi.useFakeTimers();
    try {
      const result = syncVideos([RUN], controller.signal);
      await vi.waitFor(() => expect(uploading).toBe(true));
      if (reason === 'deadline') await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      else controller.abort();
      expect(await result).toEqual({
        uploaded: [files[0]],
        failed: [
          { file: files[1], error: `PUT ${files[1]}: 403 AccessDenied` },
          { file: files[2], error: 'fetch failed (ETIMEDOUT)' },
          { file: files[3], error: 'This operation was aborted' },
        ],
        deferred: 1,
      });
      expect(fetchMock).toHaveBeenCalledTimes(4);
      const retry = await syncVideos([RUN]);
      expect(retry.uploaded).toEqual(expect.arrayContaining(files.slice(1)));
      expect(retry.uploaded).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a safe network cause code without logging its potentially sensitive message', async () => {
    const file = 'acme__shop/pr-12-0123456789abcdef0123456789abcdef/1-login.webm';
    drop(file);
    fetchMock.mockRejectedValueOnce(
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('https://signed.invalid/?secret=private'), { code: 'ETIMEDOUT' }),
      }),
    );
    expect((await syncVideos([RUN])).failed).toEqual([{ file, error: 'fetch failed (ETIMEDOUT)' }]);
    fetchMock.mockRejectedValueOnce(
      new TypeError('fetch failed', {
        cause: { code: 'https://signed.invalid/?secret=private' },
      }),
    );
    expect((await syncVideos([RUN])).failed).toEqual([{ file, error: 'fetch failed' }]);
  });

  it('does nothing without a bucket configured', async () => {
    cfgState.r2 = null;
    drop('acme__shop/pr-12-0123456789abcdef0123456789abcdef/1-login.webm');
    expect(await syncVideos([RUN])).toEqual({ uploaded: [], failed: [], deferred: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('PUTs a new video to the bucket at its relative path, signed', async () => {
    drop('acme__shop/pr-12-0123456789abcdef0123456789abcdef/1-login.webm');
    const { uploaded, failed } = await syncVideos([RUN]);
    expect(uploaded).toEqual(['acme__shop/pr-12-0123456789abcdef0123456789abcdef/1-login.webm']);
    expect(failed).toEqual([]);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      `${R2.endpoint}/${R2.bucket}/acme__shop/pr-12-0123456789abcdef0123456789abcdef/1-login.webm`,
    );
    expect(opts.method).toBe('PUT');
    // A stalled PUT must not wedge the serialized sync chain forever.
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(opts.headers['content-type']).toBe('video/webm');
    // The payload hash in the headers is the body's, and a mismatch is the first
    // thing the store rejects.
    const bodyHash = crypto.createHash('sha256').update('webm-bytes').digest('hex');
    expect(opts.headers['x-amz-content-sha256']).toBe(bodyHash);
    expect(opts.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
  });

  it('uploads a file once: the manifest remembers across syncs', async () => {
    drop('acme__shop/pr-12-0123456789abcdef0123456789abcdef/1-login.webm');
    await syncVideos([RUN]);
    const again = await syncVideos([RUN]);
    expect(again.uploaded).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries what a failed upload left behind, and keeps going past it', async () => {
    drop('acme__shop/pr-12-0123456789abcdef0123456789abcdef/1-login.webm');
    drop('acme__shop/pr-12-0123456789abcdef0123456789abcdef/2-checkout.webm');
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, text: async () => 'denied' });
    const first = await syncVideos([RUN]);
    expect(first.uploaded).toHaveLength(1);
    expect(first.failed).toEqual([
      {
        file: 'acme__shop/pr-12-0123456789abcdef0123456789abcdef/1-login.webm',
        error: 'PUT acme__shop/pr-12-0123456789abcdef0123456789abcdef/1-login.webm: 403 denied',
      },
    ]);
    const second = await syncVideos([RUN]);
    expect(second.uploaded).toEqual(['acme__shop/pr-12-0123456789abcdef0123456789abcdef/1-login.webm']);
    expect(second.failed).toEqual([]);
  });

  it('leaves dotfiles alone: the manifest itself is not evidence', async () => {
    drop('acme__shop/pr-12-0123456789abcdef0123456789abcdef/1-login.webm');
    await syncVideos([RUN]);
    fetchMock.mockClear();
    const again = await syncVideos([RUN]);
    expect(again.uploaded).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // A manifest for one bucket says nothing about another: after a repoint, "already uploaded"
  // would mean "missing from the new bucket, forever".
  it('starts over when the destination bucket changes', async () => {
    drop('acme__shop/pr-12-0123456789abcdef0123456789abcdef/1-login.webm');
    await syncVideos([RUN]);
    cfgState.r2 = { ...R2, bucket: 'qa-videos-2' };
    const again = await syncVideos([RUN]);
    expect(again.uploaded).toEqual(['acme__shop/pr-12-0123456789abcdef0123456789abcdef/1-login.webm']);
    expect(String(fetchMock.mock.calls[1][0])).toContain('/qa-videos-2/');
  });

  // Videos recorded before R2 was on sit under guessable token-free paths (`slug/pr-12/…`), made
  // when only the dashboard login saw them; enabling the bucket must never publish them.
  it('never publishes legacy token-free paths', async () => {
    drop('acme__shop/pr-12/1-login.webm');
    drop('acme__shop/stray.webm');
    drop('acme__shop/pr-12-0123456789abcdef0123456789abcdef/1-login.webm');
    const { uploaded, failed } = await syncVideos([RUN]);
    expect(uploaded).toEqual(['acme__shop/pr-12-0123456789abcdef0123456789abcdef/1-login.webm']);
    expect(failed).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // A stalling bucket costs the per-PUT timeout per pending file; the budget stops one sync
  // from working the whole pile while every later turn queues behind it.
  it('defers what the upload budget leaves undone', async () => {
    let now = 0;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      drop('acme__shop/pr-12-0123456789abcdef0123456789abcdef/1-login.webm');
      drop('acme__shop/pr-12-0123456789abcdef0123456789abcdef/2-checkout.webm');
      fetchMock.mockImplementation(async () => {
        now += 11 * 60 * 1000;
        return { ok: true };
      });
      const { uploaded, failed, deferred } = await syncVideos([RUN]);
      expect(uploaded).toHaveLength(1);
      expect(failed).toEqual([]);
      expect(deferred).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  // A chronically failing file early in the walk must not eat the budget in
  // front of everything recorded after it, sync after sync.
  it('sends files that failed last sync to the back of the line', async () => {
    drop('acme__shop/pr-12-0123456789abcdef0123456789abcdef/1-login.webm');
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'stall' });
    await syncVideos([RUN]);
    drop('acme__shop/pr-12-0123456789abcdef0123456789abcdef/2-checkout.webm');
    const { uploaded } = await syncVideos([RUN]);
    expect(uploaded).toHaveLength(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('2-checkout');
    expect(String(fetchMock.mock.calls[2][0])).toContain('1-login');
  });

  // Ten turns ending against a stalled bucket must not queue ten passes: every file on disk
  // when a sync starts is that sync's to try, so one queued retry serves them all.
  it('shares one queued sync among turns that end mid-flight', async () => {
    drop('acme__shop/pr-12-0123456789abcdef0123456789abcdef/1-login.webm');
    let release;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true });
        }),
    );
    const first = syncVideos([RUN]);
    // The stall is only real once the PUT is in flight: the sync hashes the
    // file before it ever touches the network.
    while (!release) await new Promise((r) => setTimeout(r, 2));
    const second = syncVideos([RUN]);
    const third = syncVideos([RUN]);
    expect(third).toBe(second);
    release();
    await first;
    await second;
  });

  it('percent-encodes key segments the way the signature is computed', async () => {
    drop("acme__shop/pr-12-0123456789abcdef0123456789abcdef/3-it's here!.webm");
    const { uploaded } = await syncVideos([RUN]);
    expect(uploaded).toHaveLength(1);
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      `${R2.endpoint}/${R2.bucket}/acme__shop/pr-12-0123456789abcdef0123456789abcdef/3-it%27s%20here%21.webm`,
    );
  });
});
