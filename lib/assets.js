// @ts-check
// Cache-busting for the frontend's own files.
//
// There is no bundler here (public/*.js and public/app.css are served raw)
// so nothing ever changes their URLs, and a browser is free to keep reusing a
// script it cached weeks ago next to HTML it fetched a minute ago. That desync
// is not theoretical: a commit dropped a button from developer.html while a
// cached developer.js still bound a listener to it, and the page died on the
// null element before it drew anything.
//
// So every asset URL in a page carries a hash of that file's bytes. A changed
// file is a changed URL, which no cache can answer from an old copy; an
// unchanged file keeps its URL and stays cached. The pages themselves are the
// one thing that must never be held on to, since they are what carries the
// hashes.
//
// Its own module rather than inline in server.js so the rewriting can be
// tested against a directory of fixtures without booting the app.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// Hashing every asset on every page load would be wasteful, and hashing once
// at boot would make an edit invisible until a restart, which is exactly the
// stale-file problem this module exists to solve, just moved. So the hash is
// keyed to what the file system already knows about the file: re-read it only
// when its mtime or size has moved.
/** @type {Map<string, { key: string, hash: string }>} */
const cache = new Map();

/**
 * The version stamp for one asset, or null when it is not a file we serve.
 * @param {string} dir absolute path of the directory assets are served from
 * @param {string} urlPath root-relative URL, e.g. `/developer.js`
 * @returns {string | null}
 */
export function assetVersion(dir, urlPath) {
  const file = path.join(dir, urlPath);
  // A URL that climbs out of the asset directory gets no stamp, and more to
  // the point never reaches readFileSync below.
  if (path.relative(dir, file).startsWith('..')) return null;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const key = `${stat.mtimeMs}:${stat.size}`;
  const hit = cache.get(file);
  if (hit && hit.key === key) return hit.hash;
  // Eight hex characters: enough that two versions of one file colliding is
  // not a thing that happens, short enough to keep the URLs readable.
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 8);
  cache.set(file, { key, hash });
  return hash;
}

// `src="/developer.js"` and `href="/app.css"`: the two ways the pages name a
// file of their own. Anything already carrying a query, and anything absolute
// (a CDN, a data: URI), is left exactly as written.
const ASSET_REF = /(\bsrc|\bhref)="(\/[^"?#]+\.(?:js|css))"/g;

/**
 * One page with a version stamp on every asset it names.
 * @param {string} dir absolute path of the directory assets are served from
 * @param {string} name file name of the page inside that directory
 * @returns {Promise<string>}
 */
export async function renderPage(dir, name) {
  const html = await fs.promises.readFile(path.join(dir, name), 'utf8');
  return html.replace(ASSET_REF, (whole, attr, urlPath) => {
    const version = assetVersion(dir, urlPath);
    return version ? `${attr}="${urlPath}?v=${version}"` : whole;
  });
}

/**
 * `setHeaders` for express.static: how long the browser may keep what it just
 * got. A request whose `?v=` matches the file we are about to send can be kept
 * forever, because a different file would have been asked for under a
 * different URL. Anything else (an unstamped URL, or a stamp from an older
 * build) has to be checked with us on each use, which is a 304 whenever
 * nothing moved.
 * @param {string} dir absolute path of the directory assets are served from
 */
export function assetCacheHeaders(dir) {
  return (/** @type {import('express').Response} */ res, /** @type {string} */ file) => {
    const urlPath = '/' + path.relative(dir, file).split(path.sep).join('/');
    const asked = String(res.req?.query?.v || '');
    const current = asked && assetVersion(dir, urlPath);
    res.set('Cache-Control', asked && asked === current ? 'public, max-age=31536000, immutable' : 'no-cache');
  };
}

/**
 * Send a page, stamped and never cached.
 * @param {string} dir absolute path of the directory assets are served from
 * @param {string} name file name of the page inside that directory
 */
export function pageHandler(dir, name) {
  return async (/** @type {any} */ req, /** @type {any} */ res) => {
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(await renderPage(dir, name));
  };
}
