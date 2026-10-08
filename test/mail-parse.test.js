import { describe, it, expect } from 'vitest';
import {
  MAX_BODY_CHARS,
  clip,
  decodeCharset,
  decodeEntities,
  decodeWords,
  htmlToText,
  parseAddressList,
} from '../lib/mail-parse.js';

describe('decodeWords', () => {
  it('decodes B and Q words in any charset TextDecoder knows', () => {
    expect(decodeWords('=?UTF-8?B?wqFIb2xhIQ==?=')).toBe('¡Hola!');
    expect(decodeWords('=?ISO-8859-1?Q?Caf=E9_cr=E8me?=')).toBe('Café crème');
    expect(decodeWords('Re: =?utf-8?q?r=C3=A9union?= today')).toBe('Re: réunion today');
  });

  it('joins adjacent words, so a character split across two still decodes', () => {
    // "é" is C3 A9 in UTF-8, split between the two words.
    expect(decodeWords('=?UTF-8?Q?caf=C3?= =?UTF-8?Q?=A9?=')).toBe('café');
    expect(decodeWords('=?UTF-8?B?SGVs?=\r\n =?UTF-8?B?bG8=?=')).toBe('Hello');
  });

  it('keeps the text between words that is not just whitespace', () => {
    expect(decodeWords('=?UTF-8?Q?a?= and =?UTF-8?Q?b?=')).toBe('a and b');
  });

  it('leaves plain text and unknown charsets readable', () => {
    expect(decodeWords('Plain subject')).toBe('Plain subject');
    expect(decodeWords('=?x-made-up?Q?abc?=')).toBe('abc');
    expect(decodeWords(undefined)).toBe('');
  });
});

describe('decodeCharset', () => {
  it('reads the declared charset and falls back to UTF-8', () => {
    expect(decodeCharset(Buffer.from([0x63, 0x61, 0x66, 0xe9]), 'windows-1252')).toBe('café');
    expect(decodeCharset(Buffer.from('café'), 'no-such-charset')).toBe('café');
    expect(decodeCharset(Buffer.from('café'))).toBe('café');
  });
});

describe('parseAddressList', () => {
  it('splits on the commas between addresses only', () => {
    expect(parseAddressList('"Doe, Jane" <jane@x.com>, bob@y.com, Ann <ann@z.com>')).toEqual([
      { name: 'Doe, Jane', address: 'jane@x.com' },
      { name: '', address: 'bob@y.com' },
      { name: 'Ann', address: 'ann@z.com' },
    ]);
  });

  it('decodes encoded names and unescapes quoted ones', () => {
    expect(parseAddressList('=?UTF-8?Q?Jos=C3=A9?= <jose@x.com>')).toEqual([
      { name: 'José', address: 'jose@x.com' },
    ]);
    expect(parseAddressList('"Say \\"hi\\"" <a@b.c>')).toEqual([{ name: 'Say "hi"', address: 'a@b.c' }]);
  });

  it('leaves comments out of addresses and names, and does not split on a comma in one', () => {
    expect(
      parseAddressList(
        'john@example.com (John, boss), Alice <a@example.com> (team), Ann (Sales) <ann@x.com>, ' +
          '"Smith (Jr)" <s@x.com>, b@x.com (a (nested) \\) one), c@x.com (it\'s "quoted, really")',
      ),
    ).toEqual([
      { name: '', address: 'john@example.com' },
      { name: 'Alice', address: 'a@example.com' },
      { name: 'Ann', address: 'ann@x.com' },
      { name: 'Smith (Jr)', address: 's@x.com' },
      { name: '', address: 'b@x.com' },
      { name: '', address: 'c@x.com' },
    ]);
    expect(parseAddressList('Team (internal): a@x.com, b@x.com;')).toEqual([
      { name: '', address: 'a@x.com' },
      { name: '', address: 'b@x.com' },
    ]);
  });

  it('takes the members of a group', () => {
    expect(parseAddressList('Team: a@x.com, b@x.com;')).toEqual([
      { name: '', address: 'a@x.com' },
      { name: '', address: 'b@x.com' },
    ]);
    expect(parseAddressList('undisclosed-recipients:;')).toEqual([]);
  });

  it('answers an empty list for no header', () => {
    expect(parseAddressList('')).toEqual([]);
    expect(parseAddressList(undefined)).toEqual([]);
  });
});

describe('decodeEntities', () => {
  it('decodes named and numeric entities and leaves unknown ones', () => {
    expect(decodeEntities('Tom &amp; Jerry&#39;s &lt;3 &#x1F600; &copy;')).toBe("Tom & Jerry's <3 😀 &copy;");
  });
});

describe('htmlToText', () => {
  it('keeps what a reader sees, with a line where a block ends', () => {
    const html =
      '<html><head><title>T</title><style>p{color:red}</style></head><body>' +
      '<p>Hello&nbsp;<b>there</b>,</p><div>Line two<br>Line three</div>' +
      '<ul><li>one</li><li>two</li></ul><!-- hidden --><script>alert(1)</script>' +
      '<table><tr><td>a</td><td>b</td></tr></table></body></html>';
    expect(htmlToText(html)).toBe('Hello there,\nLine two\nLine three\n• one\n• two\na b');
  });

  it('keeps a less-than sign that opens no tag as text', () => {
    expect(htmlToText('<p>1 < 2 and 3 > 2</p>')).toBe('1 < 2 and 3 > 2');
    expect(htmlToText('a < b, c <= d, <3 and x<<b>y</b>')).toBe('a < b, c <= d, <3 and x<y');
  });

  it('ends a tag at its first `>` outside a quoted attribute value', () => {
    expect(htmlToText('<p><a title="Balance > 0">Pay now</a></p>')).toBe('Pay now');
    expect(htmlToText("<img alt='a > b' src=x>after")).toBe('after');
    // A quote opens a value only right after the `=`.
    expect(htmlToText('<a href=x"y>link</a> and "more"')).toBe('link and "more"');
  });

  it('keeps its place after text whose lowercase is longer', () => {
    // `İ` lowercases to two code units.
    expect(htmlToText('<p>İstanbul</p><P>Hello</P><STYLE>secret</STYLE><script>x</script>')).toBe(
      'İstanbul\nHello',
    );
  });

  it('drops an unclosed hidden element or comment to the end', () => {
    expect(htmlToText('before<style>p{}')).toBe('before');
    expect(htmlToText('before<!-- never closed')).toBe('before');
    expect(htmlToText('before <a href="x"')).toBe('before');
  });

  it('stays linear on input built to make a backtracking pass stall', () => {
    const hostile =
      '<style'.repeat(100_000) + '<!--'.repeat(100_000) + '<b'.repeat(100_000) + '<i x=\t'.repeat(100_000);
    const started = Date.now();
    htmlToText(hostile);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('clip', () => {
  it('cuts a body past the limit and says so', () => {
    expect(clip('short')).toEqual({ text: 'short', truncated: false });
    expect(clip(null)).toEqual({ text: null, truncated: false });
    const long = clip('x'.repeat(MAX_BODY_CHARS + 5));
    expect(long.text).toHaveLength(MAX_BODY_CHARS);
    expect(long.truncated).toBe(true);
  });
});
