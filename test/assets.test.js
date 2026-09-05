import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { assetVersion, renderPage, assetCacheHeaders } from '../lib/assets.js';

// A directory of fixtures standing in for public/. The point of the module is
// that it reads real files off disk, so mocking fs would test nothing.
let dir;

function write(name, body) {
  fs.writeFileSync(path.join(dir, name), body);
}

// mtime has a coarse resolution on some file systems, and the version cache is
// keyed on it: a rewrite inside the same tick can land on the same stamp and
// the same size. Push the clock forward explicitly rather than sleeping.
function touch(name, ageMs) {
  const when = new Date(Date.now() + ageMs);
  fs.utimesSync(path.join(dir, name), when, when);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('assetVersion', () => {
  it('stamps a file with a short hash of its bytes', () => {
    write('app.js', 'console.log(1)');
    expect(assetVersion(dir, '/app.js')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('gives the same bytes the same stamp', () => {
    write('a.js', 'same');
    write('b.js', 'same');
    expect(assetVersion(dir, '/a.js')).toBe(assetVersion(dir, '/b.js'));
  });

  it('moves the stamp when the file changes', () => {
    write('app.js', 'before');
    const before = assetVersion(dir, '/app.js');
    write('app.js', 'after!!');
    touch('app.js', 5000);
    expect(assetVersion(dir, '/app.js')).not.toBe(before);
  });

  it('has nothing to say about a file that is not there', () => {
    expect(assetVersion(dir, '/missing.js')).toBeNull();
  });

  it('refuses to climb out of the asset directory', () => {
    expect(assetVersion(dir, '/../../etc/passwd')).toBeNull();
  });
});

describe('renderPage', () => {
  it('stamps the scripts and stylesheets a page names', async () => {
    write('app.css', 'body{}');
    write('app.js', 'go()');
    write('index.html', '<link rel="stylesheet" href="/app.css" /><script src="/app.js"></script>');
    const html = await renderPage(dir, 'index.html');
    expect(html).toMatch(/href="\/app\.css\?v=[0-9a-f]{8}"/);
    expect(html).toMatch(/src="\/app\.js\?v=[0-9a-f]{8}"/);
  });

  it('leaves alone what it does not serve', async () => {
    write('index.html', '<script src="https://cdn.example/x.js"></script><a href="/settings">s</a>');
    const html = await renderPage(dir, 'index.html');
    expect(html).toContain('src="https://cdn.example/x.js"');
    expect(html).toContain('href="/settings"');
  });

  it('leaves a named-but-missing file as written rather than stamping a 404', async () => {
    write('index.html', '<script src="/gone.js"></script>');
    expect(await renderPage(dir, 'index.html')).toContain('src="/gone.js"');
  });
});

describe('assetCacheHeaders', () => {
  const resFor = (v) => {
    const headers = {};
    return { req: { query: v === undefined ? {} : { v } }, set: (k, val) => (headers[k] = val), headers };
  };

  it('lets a browser keep a URL whose stamp matches the file forever', () => {
    write('app.js', 'go()');
    const res = resFor(assetVersion(dir, '/app.js'));
    assetCacheHeaders(dir)(res, path.join(dir, 'app.js'));
    expect(res.headers['Cache-Control']).toBe('public, max-age=31536000, immutable');
  });

  it('makes an unstamped URL check back every time', () => {
    write('app.js', 'go()');
    const res = resFor(undefined);
    assetCacheHeaders(dir)(res, path.join(dir, 'app.js'));
    expect(res.headers['Cache-Control']).toBe('no-cache');
  });

  // The case this module was written for: a URL carrying last week's stamp
  // must not be answered from cache, or the page keeps the old script.
  it('makes a stale stamp check back every time', () => {
    write('app.js', 'go()');
    const res = resFor('deadbeef');
    assetCacheHeaders(dir)(res, path.join(dir, 'app.js'));
    expect(res.headers['Cache-Control']).toBe('no-cache');
  });
});
