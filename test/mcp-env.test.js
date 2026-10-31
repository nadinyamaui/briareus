import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const SCRIPT = fileURLToPath(new URL('../lib/mcp-env.js', import.meta.url));

describe('mcp-env', () => {
  it('starts the server with its prefixed variables renamed back and the prefixed ones gone', () => {
    const out = execFileSync(
      process.execPath,
      [
        SCRIPT,
        'BRIAREUS_MCP_3_',
        process.execPath,
        '-e',
        'process.stdout.write(JSON.stringify([process.env.SENTRY_ACCESS_TOKEN, process.env.KEEP, Object.keys(process.env).filter((k) => k.startsWith("BRIAREUS_MCP_"))]))',
      ],
      {
        env: {
          PATH: process.env.PATH,
          KEEP: 'k',
          SENTRY_ACCESS_TOKEN: 'stale',
          BRIAREUS_MCP_3_SENTRY_ACCESS_TOKEN: 's',
          BRIAREUS_MCP_4_X: 'x',
        },
        encoding: 'utf8',
      },
    );
    expect(JSON.parse(out)).toEqual(['s', 'k', ['BRIAREUS_MCP_4_X']]);
  });

  it("passes the server's exit code on", () => {
    let status;
    try {
      execFileSync(process.execPath, [SCRIPT, 'P_', process.execPath, '-e', 'process.exit(7)'], {
        stdio: 'ignore',
      });
    } catch (e) {
      status = e.status;
    }
    expect(status).toBe(7);
  });
});
