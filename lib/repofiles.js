// @ts-check
// A project's repository for a file browser: every path at one branch or commit, and one
// file's text, read with the server's GitHub token so a client needs no checkout or token.
// The tree is pinned to the commit the branch had when read, and files are read at that
// `sha`, so what a client opens matches the tree even while the branch moves.
import { getConfig } from './config.js';
import { githubRest } from './github.js';

// GitHub's contents API sends bytes inline up to 1 MB; past that the client gets the
// size and a pointer to GitHub.
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

// GitHub's 404 and 403 pass through; 422 (no such commit) reads as not found; anything
// else is GitHub's trouble, not the client's.
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
