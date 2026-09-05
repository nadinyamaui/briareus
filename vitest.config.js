import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Agent sessions keep git worktrees under .claude/worktrees: whole copies
    // of this repo, tests and all. Globbed, they ran the suite three times over
    // and folded stale copies of lib/ into the coverage number, so a local run
    // and CI (a fresh checkout, no worktrees) disagreed about both.
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'],
    coverage: {
      provider: 'v8',
      // The whole backend, tested or not, so an untested module counts against
      // the number instead of hiding from it. server.js stays out: it boots
      // the app at import, so covering it means integration tests, not units.
      include: ['lib/**'],
      // The floor is what the suite actually covers today, minus a hair of
      // slack. It only ratchets up: raise it when coverage lands, and a PR
      // that drops below it goes red in CI.
      thresholds: { statements: 58, branches: 54, functions: 59, lines: 58 },
    },
  },
});
