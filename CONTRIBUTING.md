# Contributing

Thanks for looking. This is a small, opinionated project, and the conventions
below are not style preferences so much as the reason the codebase stays
readable without a framework holding it together.

## Getting it running

See [Requirements](README.md#requirements) and [Setup](README.md#setup) in the
README. The short version:

```bash
npm install
npm run build:css        # not committed; the pages are unstyled without it
cp .env.example .env     # then fill in the required half
npm start                # http://localhost:4300
```

You need a MySQL you can create databases on, Node 24 (what `.nvmrc` pins), and
at least the Claude Code CLI authenticated. You do **not** need the database
pool, a public hostname, or webhooks to work on most of this; those are for
running many sessions in parallel, and everything degrades to polling without
them.

## Before you open a pull request

CI runs exactly these, and nothing else:

```bash
npm run format:check && npm run lint && npm run typecheck && npm run test:coverage
```

Run `npm run format` to fix formatting rather than hand-matching Prettier.

## The conventions that matter

- **Plain ESM JavaScript.** No TypeScript, no transpiler, no bundler. `node
server.js` runs the source as it is written, and `public/*.js` is served
  raw. Type-checking happens through JSDoc on files marked `// @ts-check`, run
  by `npm run typecheck`.
- **Comments explain why, not what.** The register throughout is prose about
  intent and trade-offs: why a module is alone, why a default was refused, why
  a cadence is what it is. A comment that narrates the next line is worse than
  no comment.
- **Machine-describing settings get no default.** `lib/config.js` refuses to
  boot when one is missing, by name, rather than guessing at somebody else's
  setup. Only machine-neutral behavior (timeouts, poll cadences) gets a
  default. New settings follow that split and get documented in `.env.example`.
- **Never read `process.env` outside `lib/config.js`.**
- **GitHub access goes through `lib/github.js`.** It owns the rate-limit
  backoff; a `fetch` to `api.github.com` from anywhere else routes around it.
- **Contract strings never change.** The comment anchors and the
  `[reviewer-fix]` commit line live in `lib/markers.js`. Pull requests that
  already exist carry them, and changing one makes every older PR unreadable to
  this app.
- **Schema changes are migrations.** One timestamped file in `migrations/`
  exporting `up` and `down` (`npm run make:migration add_x_to_y`). Never edit a
  migration that has shipped.
- **New runtime dependencies need a strong reason.** The app is `express` +
  `mysql2` + `umzug` + the provider CLIs on purpose.

## Tests

Vitest, one file per `lib/` module. Add or update the test file alongside the
module you touch. `test/` is a mirror of `lib/`, and a new module without one
stands out. `npm run test:watch` while you work.

## Styling

Tailwind v4, source in `src/app.css`, palette declared in `src/theme.css` as
`@theme` tokens. The compiled `public/app.css` is **not** committed and
`npm start` does not build it, so a fresh clone needs it once and every class
you add needs it again:

```bash
npm run build:css        # once, minified
npm run watch:css        # while editing
```

There is nothing to commit: the deploy builds its own copy (the image in a
stage of its own, a bare-metal checkout with `npm run build:css` after the
pull). A screenshot in the pull request is what shows the styles landed.

## Documentation

The site at <https://nadinyamaui.github.io/briareus/> is `docs/`, published by
`.github/workflows/pages.yml` on a merge to `main`: plain HTML, no generator,
and the only build is the stylesheet. Each page holds
nothing but its own `<article class="doc">`; `docs/docs.js` builds the sidebar,
the "on this page" rail, the copy buttons and the prev/next footer around it, so
a new page means writing its prose and adding one line to `NAV`.

Its stylesheet is built the same way the app's is, from `src/docs.css` (which
imports the same `src/theme.css` palette), and is not committed either. Build
it to look at a page locally; the Pages workflow builds its own before
publishing:

```bash
npm run build:docs-css
```

CI builds both stylesheets, so a source that no longer compiles fails there
rather than in a deploy.

## Commits and pull requests

Keep a pull request to one change. The template asks what it does and how you
checked it; a screenshot for anything visual saves a round trip.

If you are planning something large, open an issue first: this app is
shaped around one way of working, and it is kinder to find out early that a
change cuts against it.

## Versions

Every merged pull request tags `main` as `VX.Y` and publishes a GitHub release
with generated notes. Nothing is manual and nothing needs a version bump in the
diff. `package.json` carries no meaningful version, because the `main` ruleset
allows no bot commits and the tag is the only honest place for one.

The bump is minor by default. Two labels change that:

- **`release: major`**: the merge takes `VX.Y` to `V(X+1).0`. For anything
  that makes an existing setup stop working: a required new `.env` setting, a
  removed route, a migration that cannot be rolled back.
- **`release: skip`**: the merge tags nothing. For changes with no effect on
  anyone running this: a README typo, a CI tweak.

To find out which version a checkout is:

```bash
git describe --tags --match 'V*'
```
