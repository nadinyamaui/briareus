// @ts-check
// The text work mail sync needs and no library is pulled in for: address
// headers, RFC 2047 encoded words, bytes in a declared charset, and a plain
// text rendering of an HTML body for a message that sent no text part.
//
// Everything here reads what a stranger wrote, so none of it may take time
// out of proportion to its input: the HTML pass scans forward once with
// indexOf rather than with backtracking regular expressions an unclosed
// `<style` or `<!--` repeated a hundred thousand times would stall.

/**
 * @typedef {{ name: string, address: string }} MailAddress
 */

// Bytes in the charset a part declared, or UTF-8 when it declared one this
// runtime does not know (TextDecoder knows the WHATWG list: latin1, the
// windows-125x pages, the ISO-8859 family, Shift_JIS, GBK, Big5, …).
/** @param {Uint8Array} bytes @param {string} [charset] */
export function decodeCharset(bytes, charset) {
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;

/** @param {string} encoding @param {string} data */
function wordBytes(encoding, data) {
  if (encoding.toUpperCase() === 'B') return Buffer.from(data, 'base64');
  const latin = data
    .replace(/_/g, ' ')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return Buffer.from(latin, 'latin1');
}

// RFC 2047: `=?charset?B|Q?data?=` inside a header. The whitespace between
// two encoded words is not part of the text, and a multi-byte character may
// be split across them, so adjacent words in one charset are joined as bytes
// before they are decoded.
/** @param {unknown} text */
export function decodeWords(text) {
  const s = String(text ?? '');
  if (!s.includes('=?')) return s;
  let out = '';
  let at = 0;
  /** @type {{ charset: string, bytes: Buffer[] } | null} */
  let run = null;
  const flush = () => {
    if (run) out += decodeCharset(Buffer.concat(run.bytes), run.charset);
    run = null;
  };
  for (const m of s.matchAll(ENCODED_WORD)) {
    const index = /** @type {number} */ (m.index);
    const between = s.slice(at, index);
    // RFC 2231 lets a charset carry a language after `*`; it says nothing
    // about the bytes.
    const charset = m[1].split('*')[0].toLowerCase();
    if (!run || between.trim() || run.charset !== charset) {
      flush();
      out += between;
      run = { charset, bytes: [] };
    }
    run.bytes.push(wordBytes(m[2], m[3]));
    at = index + m[0].length;
  }
  flush();
  return out + s.slice(at);
}

// Splits on the commas that separate addresses, not the ones inside a quoted
// display name, an angle-bracketed address or a comment. Comments are left
// out (`a@x.com (Ann, boss)` is the address a@x.com): outside a quoted
// string, `(` opens one, and like a quoted string it takes `\` escapes, but
// it may nest.
/** @param {string} header */
function splitAddresses(header) {
  const parts = [];
  let current = '';
  let quoted = false;
  let angle = false;
  let comment = 0;
  for (let i = 0; i < header.length; i++) {
    const c = header[i];
    if (comment) {
      if (c === '\\') i++;
      else if (c === '(') comment++;
      else if (c === ')' && !--comment) current += ' ';
      continue;
    }
    if (c === '\\' && quoted) {
      current += c + (header[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === '(') {
      comment = 1;
      continue;
    } else if (!quoted && c === '<') angle = true;
    else if (!quoted && c === '>') angle = false;
    else if (!quoted && !angle && (c === ',' || c === ';')) {
      parts.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

// `From`, `To`, `Cc` and `Reply-To` as `{ name, address }` pairs. A group
// (`Team: a@x, b@y;`) contributes its members; its name is dropped.
/** @param {unknown} header @returns {MailAddress[]} */
export function parseAddressList(header) {
  const out = [];
  for (let part of splitAddresses(String(header ?? ''))) {
    const group = /^[^"<@]*:\s*/.exec(part);
    if (group) part = part.slice(group[0].length).trim();
    if (!part) continue;
    const angle = /^(.*?)<([^>]*)>\s*$/.exec(part);
    const rawName = angle ? angle[1].trim() : '';
    const address = (angle ? angle[2] : part).trim().replace(/^mailto:/i, '');
    const name = decodeWords(rawName.replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1')).trim();
    out.push({ name, address });
  }
  return out;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

/** @param {string} text */
export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]+\d*);/gi, (all, name) => {
    const key = name.toLowerCase();
    if (key.startsWith('#x') || key.startsWith('#')) {
      const code = key.startsWith('#x') ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return all;
      }
    }
    return Object.hasOwn(ENTITIES, key) ? ENTITIES[key] : all;
  });
}

// Elements whose content is never text a reader sees.
const HIDDEN = ['script', 'style', 'head', 'title', 'template'];
// Elements that sit on lines of their own.
const BLOCK = new Set([
  'p',
  'div',
  'tr',
  'li',
  'ul',
  'ol',
  'table',
  'blockquote',
  'section',
  'article',
  'header',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'pre',
  'hr',
]);

// Where a tag ends: its first `>` outside a quoted attribute value (`title="a
// > b"`). As HTML reads it, a quote opens a value only right after the `=`;
// -1 when the tag does not end.
/** @param {string} source @param {number} from */
function tagEnd(source, from) {
  const next = /=[ \t\n\f\r]*(["'])|>/g;
  next.lastIndex = from;
  for (let m = next.exec(source); m; m = next.exec(source)) {
    if (!m[1]) return m.index;
    const close = source.indexOf(m[1], next.lastIndex);
    if (close === -1) return -1;
    next.lastIndex = close + 1;
  }
  return -1;
}

// A plain rendering of an HTML body: what a reader would see, line breaks
// where blocks end, no markup. It is for a list's preview, a search and a
// client with no HTML view, not a faithful conversion.
/** @param {string} html */
export function htmlToText(html) {
  const source = String(html ?? '');
  // Tag names are matched in ASCII only, as HTML matches them: a full
  // toLowerCase can change the length (`İ` becomes two code units) and
  // shift every offset after it.
  const lower = source.replace(/[A-Z]+/g, (s) => s.toLowerCase());
  let out = '';
  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      out += source.slice(i);
      break;
    }
    out += source.slice(i, lt);
    if (lower.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    // As HTML reads it, `<` opens markup only before a letter, `/`, `!` or
    // `?`; anything else (`1 < 2`, `a < b`) is the character itself.
    const tag = /^<(\/?)([a-z][a-z0-9]*)/.exec(lower.slice(lt, lt + 40));
    if (!tag && !/^<[/!?]/.test(lower.slice(lt, lt + 2))) {
      out += '<';
      i = lt + 1;
      continue;
    }
    const gt = tag ? tagEnd(source, lt + 1) : source.indexOf('>', lt + 1);
    if (gt === -1) break;
    i = gt + 1;
    if (!tag) continue;
    const [, closing, name] = tag;
    if (!closing && HIDDEN.includes(name)) {
      const end = lower.indexOf(`</${name}`, i);
      const after = end === -1 ? -1 : source.indexOf('>', end);
      i = after === -1 ? source.length : after + 1;
      continue;
    }
    if (name === 'br') out += '\n';
    else if (BLOCK.has(name)) {
      // A block starts and ends on a line of its own, without the blank line
      // a closing tag followed by an opening one would otherwise leave.
      if (!/\n[ \t]*$/.test(out.slice(-40))) out += '\n';
      if (name === 'li' && !closing) out += '• ';
    } else if ((name === 'td' || name === 'th') && !closing) out += ' ';
  }
  return decodeEntities(out)
    .replace(/[ \t\f\v\u00a0\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// A body cut to what one row may hold. Characters, not bytes: MEDIUMTEXT
// takes 16 MB, and at four bytes a character this stays well inside it and
// inside the database's packet limit.
export const MAX_BODY_CHARS = 500_000;

/** @param {string | null} text @returns {{ text: string | null, truncated: boolean }} */
export function clip(text) {
  if (text == null || text.length <= MAX_BODY_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_BODY_CHARS), truncated: true };
}
