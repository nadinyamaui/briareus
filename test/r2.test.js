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
  it('does nothing without a bucket configured', async () => {
    cfgState.r2 = null;
    drop('acme__shop/pr-12-0123456789abcdef0123456789abcdef/1-login.webm');
    expect(await syncVideos()).toEqual({ uploaded: [], failed: [], deferred: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('PUTs a new video to the bucket at its relative path, signed', async () => {
    drop('acme__shop/pr-12-0123456789abcdef0123456789abcdef/1-login.webm');
    const { uploaded, failed } = await syncVideos();
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
    await syncVideos();
    const again = await syncVideos();
    expect(again.uploaded).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries what a failed upload left behind, and keeps going past it', async () => {
    drop('acme__shop/pr-12-0123456789abcdef0123456789abcdef/1-login.webm');
    drop('acme__shop/pr-12-0123456789abcdef0123456789abcdef/2-checkout.webm');
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, text: async () => 'denied' });
    const first = await syncVideos();
    expect(first.uploaded).toHaveLength(1);
    expect(first.failed).toEqual([
      {
        file: 'acme__shop/pr-12-0123456789abcdef0123456789abcdef/1-login.webm',
        error: 'PUT acme__shop/pr-12-0123456789abcdef0123456789abcdef/1-login.webm: 403 denied',
      },
    ]);
    const second = await syncVideos();
    expect(second.uploaded).toEqual(['acme__shop/pr-12-0123456789abcdef0123456789abcdef/1-login.webm']);
    expect(second.failed).toEqual([]);
  });

  it('leaves dotfiles alone: the manifest itself is not evidence', async () => {
    drop('acme__shop/pr-12-0123456789abcdef0123456789abcdef/1-login.webm');
    await syncVideos();
    fetchMock.mockClear();
    const again = await syncVideos();
    expect(again.uploaded).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // A manifest written for one bucket says nothing about another: after the
  // install is pointed elsewhere, "already uploaded" would mean "missing from
  // the new bucket, forever".
  it('starts over when the destination bucket changes', async () => {
    drop('acme__shop/pr-12-0123456789abcdef0123456789abcdef/1-login.webm');
    await syncVideos();
    cfgState.r2 = { ...R2, bucket: 'qa-videos-2' };
    const again = await syncVideos();
    expect(again.uploaded).toEqual(['acme__shop/pr-12-0123456789abcdef0123456789abcdef/1-login.webm']);
    expect(String(fetchMock.mock.calls[1][0])).toContain('/qa-videos-2/');
  });

  // Videos recorded before R2 was switched on live under token-free paths
  // (`slug/pr-12/…`), guessable from the pull request itself, and recorded
  // when the dashboard's login was the only audience. Publishing them
  // retroactively is the one thing enabling the bucket must not do.
  it('never publishes legacy token-free paths', async () => {
    drop('acme__shop/pr-12/1-login.webm');
    drop('acme__shop/stray.webm');
    drop('acme__shop/pr-12-0123456789abcdef0123456789abcdef/1-login.webm');
    const { uploaded, failed } = await syncVideos();
    expect(uploaded).toEqual(['acme__shop/pr-12-0123456789abcdef0123456789abcdef/1-login.webm']);
    expect(failed).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // A bucket that stalls on every connection costs the per-PUT timeout per
  // pending file; the budget stops one sync from serving the whole pile while
  // every later turn queues behind it.
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
      const { uploaded, failed, deferred } = await syncVideos();
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
    await syncVideos();
    drop('acme__shop/pr-12-0123456789abcdef0123456789abcdef/2-checkout.webm');
    const { uploaded } = await syncVideos();
    expect(uploaded).toHaveLength(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('2-checkout');
    expect(String(fetchMock.mock.calls[2][0])).toContain('1-login');
  });

  // Ten turns ending against a stalled bucket must not queue ten passes over
  // the same stuck files: every file on disk when a sync starts is that
  // sync's to try, so one queued retry serves them all.
  it('shares one queued sync among turns that end mid-flight', async () => {
    drop('acme__shop/pr-12-0123456789abcdef0123456789abcdef/1-login.webm');
    let release;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true });
        }),
    );
    const first = syncVideos();
    // The stall is only real once the PUT is in flight: the sync hashes the
    // file before it ever touches the network.
    while (!release) await new Promise((r) => setTimeout(r, 2));
    const second = syncVideos();
    const third = syncVideos();
    expect(third).toBe(second);
    release();
    await first;
    await second;
  });

  it('percent-encodes key segments the way the signature is computed', async () => {
    drop("acme__shop/pr-12-0123456789abcdef0123456789abcdef/3-it's here!.webm");
    const { uploaded } = await syncVideos();
    expect(uploaded).toHaveLength(1);
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      `${R2.endpoint}/${R2.bucket}/acme__shop/pr-12-0123456789abcdef0123456789abcdef/3-it%27s%20here%21.webm`,
    );
  });
});
