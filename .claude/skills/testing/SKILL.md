---
name: testing
description: How to run and write tests in this repo: Vitest over ESM, the mocking conventions for lib/db.js and lib/config.js, and the module-level-cache traps. Use whenever adding code to lib/, fixing a bug, or asked to run the tests.
---

# Testing in this repo

The suite is **Vitest** over plain ESM JavaScript. Tests live in `test/*.test.js`,
one file per `lib/` module.

```
npm test          # vitest run, the CI entry point
npm run test:watch
```

## The mocking conventions

Nothing in the suite touches the network, MySQL, or a real GitHub. The two
modules almost every `lib/` file imports are mocked at the top of each test
file:

- `lib/config.js`: `getConfig()` reads `.env` at boot and **throws** when keys
  are missing, so tests never call the real one. Mock it returning only the
  keys the module under test reads:

  ```js
  vi.mock('../lib/config.js', () => ({ getConfig: () => ({ githubToken: 'tok' }) }));
  ```

- `lib/db.js`: imports `mysql2` and wants a live server. Mock the specific
  functions the module under test imports (`loadAppSetting`, `saveAppSetting`,
  `loadFindingDecisions`, …).

When the mock needs per-test state, declare it with `vi.hoisted()`; `vi.mock`
factories are hoisted above module scope and can't close over a plain `const`.

## The module-level-cache traps

Several `lib/` modules keep state at module level; tests must not share it:

- `lib/findings.js` and `lib/prboard.js` cache per `repo#pr` / per repo with a
  TTL. Use a **unique repo name per test** (see the `beforeEach` counters in
  `test/findings.test.js` / `test/prboard.test.js`) or pass `{ fresh: true }`.
- `lib/webhooksecrets.js` caches the secrets after the first read. Tests that
  care use `vi.resetModules()` + a fresh dynamic `import()` per test.
- `lib/auth.js` keeps the login-lockout map in memory. Use a unique IP string
  per test.
- `lib/templates.js` keeps the global overrides in memory. A test that calls
  `saveGlobalTemplates` must reset with `saveGlobalTemplates({})` before ending.

## What a change must ship with

- New logic in `lib/` gets tests in the matching `test/<module>.test.js`.
- `test/markers.test.js` pins the three strings written into existing PRs
  (anchors and the fix-commit marker). If it fails, you are breaking every pull
  request written before your change, so change the code back, not the test.
- Router-level behavior (see `test/webhooks.test.js`) is tested against a real
  Express app on an ephemeral port with `fetch`, with no supertest dependency.
