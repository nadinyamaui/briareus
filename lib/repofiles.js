// @ts-check
// A project's repository as a file browser reads it: every path at one branch
// or commit, and one file's text. Both read GitHub with the server's token, so
// a client browses code without a checkout or a token of its own.
//
// The tree is pinned to the commit the branch pointed at when it was read, and
// a client reads files at that commit (`ref` = the tree's `sha`), so what it
// opens matches the tree it shows even while the branch moves on.
import { Readable, Transform, pipeline } from 'node:stream';
import { getConfig } from './config.js';
import { githubRest } from './github.js';

// GitHub's contents API sends a file's bytes inline up to 1 MB; past that a
// client is told the size and pointed at GitHub.
export const MAX_FILE_BYTES = 1024 * 1024;

const fail = (message, status) => Object.assign(new Error(message), { status });

// A branch, tag or commit as a client names it: no "..", no leading or
// trailing slash, nothing that is not a ref's character.
function checkRef(ref) {
  if (
    typeof ref !== 'string' ||
    !ref ||
    ref.length > 255 ||
    ref.includes('..') ||
    ref.startsWith('/') ||
    ref.endsWith('/') ||
    ref.endsWith('.') ||
    ref === '@' ||
    ref.includes('@{') ||
    /[\x00-\x20\x7f~^:?*[\\]/.test(ref) ||
    ref.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'))
  )
    throw fail('`ref` must be a branch, tag or commit', 400);
  return ref;
}

// A path from the repository's root: no leading slash, no "." or ".." part.
function checkPath(path) {
  if (typeof path !== 'string' || !path || path.length > 1024 || path.startsWith('/') || path.includes('\0'))
    throw fail('`path` must be a file’s path from the repository’s root', 400);
  if (path.split('/').some((part) => part === '' || part === '.' || part === '..'))
    throw fail('`path` must be a file’s path from the repository’s root', 400);
  return path;
}

const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');

// GitHub's 404 and 403 go out as they are; 422 (a ref it has no commit for)
// reads as not found; anything else is GitHub's trouble, not the client's.
function githubFailure(res, what) {
  const status = res.status === 422 ? 404 : res.status === 404 || res.status === 403 ? res.status : 502;
  return fail(`GitHub answered ${res.status} reading ${what}`, status);
}

/**
 * Every file and folder at `ref` (the default branch when absent).
 * @param {{ repo: string }} project
 * @param {string} [ref]
 */
export async function repoTree(project, ref) {
  const cfg = getConfig();
  if (!cfg.githubToken) throw fail('No GITHUB_TOKEN is configured', 503);
  let wanted = ref ? checkRef(ref) : null;
  if (!wanted) {
    const infoRes = await githubRest(cfg, 'GET', `/repos/${project.repo}`);
    if (!infoRes.ok) throw githubFailure(infoRes, 'the default branch');
    const info = await infoRes.json();
    wanted = info.default_branch;
    if (!wanted) throw fail('The repository has no default branch', 404);
  }
  // The commit first, so the tree and every file read after it agree.
  const commitRes = await githubRest(
    cfg,
    'GET',
    `/repos/${project.repo}/commits/${encodeURIComponent(wanted)}`,
  );
  if (!commitRes.ok) throw githubFailure(commitRes, `${wanted}`);
  const commit = await commitRes.json();
  const treeSha = commit?.commit?.tree?.sha;
  if (!commit?.sha || !treeSha) throw fail(`GitHub sent no tree for ${wanted}`, 502);
  // A tree at a SHA never changes, so its ETag keeps a second read free.
  const treeRes = await githubRest(
    cfg,
    'GET',
    `/repos/${project.repo}/git/trees/${treeSha}?recursive=1`,
    undefined,
    {
      conditional: true,
    },
  );
  if (!treeRes.ok) throw githubFailure(treeRes, `the tree of ${wanted}`);
  const tree = await treeRes.json();
  const entries = (tree.tree || [])
    // Submodules ("commit") show as folders that cannot be opened; they are left out.
    .filter((e) => e.type === 'blob' || e.type === 'tree')
    .map((e) =>
      e.type === 'tree'
        ? { path: e.path, type: 'tree' }
        : { path: e.path, type: 'blob', size: e.size ?? null },
    );
  return { ref: wanted, sha: commit.sha, truncated: Boolean(tree.truncated), entries };
}

// Text is what decodes as UTF-8 and holds no NUL in its first 8 KB.
function asText(bytes) {
  if (bytes.subarray(0, 8192).includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * One file's text at `ref` (the default branch when absent), or its size alone
 * when it is binary or too large to send.
 * @param {{ repo: string }} project
 * @param {string | undefined} ref
 * @param {string} path
 */
export async function repoFile(project, ref, path) {
  const cfg = getConfig();
  if (!cfg.githubToken) throw fail('No GITHUB_TOKEN is configured', 503);
  checkPath(path);
  const wanted = ref ? checkRef(ref) : null;
  const query = wanted ? `?ref=${encodeURIComponent(wanted)}` : '';
  const res = await githubRest(
    cfg,
    'GET',
    `/repos/${project.repo}/contents/${encodePath(path)}${query}`,
    undefined,
    {
      conditional: true,
    },
  );
  if (!res.ok) throw githubFailure(res, path);
  const raw = await res.json();
  if (Array.isArray(raw) || raw?.type !== 'file') throw fail(`${path} is not a file`, 400);
  const size = Number(raw.size) || 0;
  const row = { path, ref: wanted || '', size, url: raw.html_url || null };
  // GitHub leaves `content` empty past 1 MB (`encoding: none`).
  if (size > MAX_FILE_BYTES || raw.encoding !== 'base64' || typeof raw.content !== 'string')
    return { ...row, content: null, binary: false, tooLarge: true };
  const text = asText(Buffer.from(raw.content, 'base64'));
  if (text === null) return { ...row, content: null, binary: true, tooLarge: false };
  return { ...row, content: text, binary: false, tooLarge: false };
}

// A whole repository is downloaded for a client's local index (Go to Class,
// Find in Files, Go to Declaration); one larger than this is refused rather
// than streamed for minutes.
export const MAX_ARCHIVE_BYTES = 300 * 1024 * 1024;

/**
 * The repository at `ref` as GitHub's gzipped tarball, streamed: one top
 * folder holding every file. `size` is GitHub's Content-Length when it sends
 * one; the stream fails past MAX_ARCHIVE_BYTES either way.
 * @param {{ repo: string }} project
 * @param {string} ref
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function repoArchive(project, ref, { signal } = {}) {
  const cfg = getConfig();
  if (!cfg.githubToken) throw fail('No GITHUB_TOKEN is configured', 503);
  const wanted = checkRef(ref);
  // GitHub answers with a redirect to codeload, which carries its own short-lived
  // grant; fetch follows it.
  const res = await githubRest(
    cfg,
    'GET',
    `/repos/${project.repo}/tarball/${encodeURIComponent(wanted)}`,
    undefined,
    {
      signal,
    },
  );
  if (!res.ok) throw githubFailure(res, `the archive of ${wanted}`);
  const size = Number(res.headers.get('content-length')) || null;
  if (size && size > MAX_ARCHIVE_BYTES) {
    if ('body' in res) await res.body?.cancel().catch(() => {});
    throw fail(`The repository’s archive is over ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB`, 413);
  }
  // Never a cached answer: this read is not conditional, so it is fetch's own Response.
  const body = 'body' in res ? res.body : null;
  if (!body) throw fail('GitHub sent no archive', 502);
  let sent = 0;
  const limit = new Transform({
    transform(chunk, _encoding, done) {
      sent += chunk.length;
      if (sent > MAX_ARCHIVE_BYTES) done(fail('The repository’s archive is too large', 413));
      else done(null, chunk);
    },
  });
  // Pipeline forwards source errors and cancels the fetch body when the
  // limit fails or the caller destroys the returned stream.
  pipeline(Readable.fromWeb(/** @type {any} */ (body)), limit, () => {});
  return { stream: limit, size };
}
