---
name: stack
description: The conventions of this codebase: plain ESM JavaScript (no TypeScript, no bundler), Express 5, mysql2, an API-only server with no UI, .env-driven config, and the comment style. Use before writing or reviewing any code in server.js, lib/ or scripts/.
---

# This project's stack and conventions

**Node.js ≥ 24, plain ESM JavaScript.** There is no TypeScript, no transpiler
and no bundler anywhere. `node server.js` runs the source as-is. Do not
introduce TS, JSX, a build step, or `require()`.

**The core, with no UI.** This repo is the server only: no pages, no static
files, no browser login. Every client (web, desktop, iOS) lives in a repository
of its own and talks to `/api/v1` with a token. Client-facing behaviour is a
route in `lib/api-v1-catalog.js` (then `npm run build:api-docs`), never a page
or an ad-hoc route.

## Layout

- `server.js`: the Express 5 app, every handler, SSE streams. The handlers sit
  on a router only `/api/v1` (lib/api-v1.js) and the agent routes reach.
- `lib/`: one module per concern (sessions in `jobs.js`, provider CLIs in
  `providers.js`, GitHub in `github.js`, prompts in `templates.js`/`prtasks.js`,
  …). Modules that two sides need live alone to avoid import cycles
  (`markers.js`, `webhooksecrets.js`); respect that when adding imports.
- `migrations/`: the app's own schema, one timestamped file per change.
- `test/`: Vitest, one file per lib module (see the `testing` skill).

## Configuration

Everything machine-specific comes from `.env` through `lib/config.js`'s
`getConfig()`. The philosophy is explicit there: **machine-describing keys have
no defaults** and a missing one stops the boot by name; only machine-neutral
behavior (timeouts, poll cadences) gets a default. Follow that split when
adding a setting, and document it in `.env.example`. Never read
`process.env` directly from other modules.

App-level mutable settings (webhook secrets, prompt template overrides) live in
the `app_settings` DB table via `loadAppSetting`/`saveAppSetting`, not in .env.

## Patterns to keep

- **Express 5**: async handlers may throw/reject; no `next(err)` boilerplate.
- **GitHub access** goes through `lib/github.js` (`githubRest`/`githubGraphql`)
  and it owns rate-limit backoff. Never call `fetch('https://api.github.com…')`
  from elsewhere.
- **Module-level caches with TTLs** are the house style for GitHub reads
  (`prboard.js`, `findings.js`, branch listing). Invalidate on writes.
- **Contract strings** (comment anchors, the fix-commit marker) live in
  `lib/markers.js` and must never change: old PRs carry them.
- **Comments explain why, not what.** The codebase's comments are prose about
  intent and trade-offs ("Its own module because both sides need it…"). Match
  that register; never narrate the next line.
- Timestamps are `Date.now()` epoch millis; ids are short hex/crypto strings.
- **Formatting is Prettier's job** (`.prettierrc.json`: single quotes, width
  110, trailing commas). Run `npm run format` before committing; CI runs
  `npm run format:check` and fails on drift. The lockfile is ignored.
- **Type-checking without TypeScript**: files starting with `// @ts-check` are
  checked by `npm run typecheck` (tsc over JSDoc, CI-gated). All of lib/ is
  opted in except `jobs.js`, `dbpool.js` (mysql2 typing friction) and
  `memory-mcp.js`; new files should start with the marker.
- **Schema changes are migrations.** `migrations/` holds one timestamped file
  per change, each exporting `up` and `down`, run in name order and recorded in
  the `migrations` table ([umzug](https://github.com/sequelize/umzug), mysql2 as
  the only driver). The server applies pending ones at boot, and
  `npm run make:migration add_x_to_y` scaffolds one. Never edit a migration
  that has shipped; add a new one. `lib/db.js` owns the connection,
  `lib/migrator.js` the running of them; neither carries table definitions.

## What not to do

- No new runtime dependencies without a strong reason: the app runs on
  `express` + `mysql2` + `umzug` + the provider CLIs, deliberately lean.
- No ORM, and no query builder: `lib/db.js` hands out a mysql2 pool and the
  modules write their own SQL.
- No pages, static files or browser-only features (cookies, CORS, web push):
  those belong to a client's repository.
