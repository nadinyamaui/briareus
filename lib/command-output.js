// @ts-check
// Output of a setup step, read for the session log and for the one-line reason a
// failed step gives. The tail of a failed run is often just a stack trace (Laravel's
// Collision prints the exception first, then the frames), so the reason also carries
// the headline of the last error report and the line after it, which usually holds
// the message.

// CSI sequences (colours, cursor moves). Some tools emit them despite NO_COLOR:
// Collision dims its "+17 vendor frames" lines whatever the environment says.
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/** @param {string} text */
export const stripAnsi = (text) => text.replace(ANSI_RE, '');

// A line that opens an error report: an exception class on its own or before its
// message ("TypeError", "Illuminate\Database\QueryException", "Error: Cannot find
// module", Composer's "[RuntimeException]"), PHP's "Fatal error", git's "fatal:",
// npm's "npm error" ("npm ERR!" before npm 10). Stack frames ("Foo\BarException::baz()",
// "PDOException::(…)") never match.
const HEADLINE_RE =
  /^(?:\[?[\w\\.]*(?:Error|Exception)\]?(?::(?!:)|\s|$)|(?:PHP )?(?:Fatal|Parse) error\b|fatal:|npm (?:ERR!|error\b))/;
const NPM_RE = /^npm (?:ERR!|error\b)/;

const KEEP = 20;

export function outputTail() {
  /** @type {string[]} */
  const lines = [];
  /** @type {string[] | null} */
  let headline = null;
  let headlineAt = -1;
  let count = 0;
  let lastOpened = false;
  return {
    /** Adds one trimmed, non-empty line, already stripped of ANSI codes. @param {string} text */
    push(text) {
      if (headline && headline.length === 1 && count === headlineAt + 1) headline.push(text);
      // The last error report wins: an earlier one may have been tolerated (a retried
      // connection, a `git describe` with no tags). A report spans consecutive headline
      // lines, so npm's block of "npm error" lines counts once. That block only sums up
      // a script that failed, so it never replaces the script's own report.
      const opens = HEADLINE_RE.test(text);
      if (opens && !lastOpened && !(headline && NPM_RE.test(text))) {
        headline = [text];
        headlineAt = count;
      }
      lastOpened = opens;
      count++;
      lines.push(text);
      if (lines.length > KEEP) lines.shift();
    },
    /** The last `tail` lines, after the headline when it scrolled out of them. */
    summary(tail = 5) {
      const last = lines.slice(-tail);
      if (!headline || headlineAt >= count - tail) return last.join(' | ');
      // The headline's second line may itself be in the tail.
      const head = headline.slice(0, Math.max(1, count - tail - headlineAt));
      const gap = headlineAt + head.length < count - tail ? ['…'] : [];
      return [...head, ...gap, ...last].join(' | ');
    },
  };
}
