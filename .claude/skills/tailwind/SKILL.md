---
name: tailwind
description: How styling works in this repo: Tailwind CSS v4, the gitignored build output, the theme tokens, and when public/app.css must be rebuilt. Use before touching any class name, color, or layout in public/*.html, public/*.js or src/app.css.
---

# Tailwind in this repo

This project uses **Tailwind CSS v4** via `@tailwindcss/cli`. There is **no
`tailwind.config.js`**; v4 is configured entirely inside the CSS source.

## The files

- `src/app.css`: the only source. It starts with `@import "tailwindcss"` and
  `@source "../public"`, so utility classes are discovered from everything under
  `public/` (the HTML pages and the JS that builds DOM with class strings).
- `public/app.css`: the build output. **Gitignored**, and `node server.js`
  never builds CSS: it serves whatever the last local build left there. The
  deploy builds its own copy (the Docker image in a stage of its own, a
  bare-metal checkout with `npm run build:css` after the pull), and GitHub
  Pages the same for `docs/docs.css` via `.github/workflows/pages.yml`.

## The one rule

Any change that adds, removes or renames a Tailwind class anywhere under
`public/`, or edits `src/app.css`, requires rebuilding `public/app.css`:

```
npm run build:css
```

(`npm run watch:css` while iterating.) There is nothing to commit, and nothing
in CI to catch it either: without the rebuild the class has no styles behind it
locally, which fails silently and only visually.

## The theme

All colors are custom tokens declared in the `@theme` block of `src/app.css`:
`bg-canvas`, `bg-sidebar`, `bg-raise`, `bg-field`, `bg-sunken`, `border-line`,
`border-line-strong`, `text-ink`, `text-muted`, `text-accent`, `accent-dim`,
`ok`, `warn`, `danger`. **Never** use Tailwind's stock palette
(`bg-gray-800`, `text-red-500`, …); the app is a single dark theme and every
surface must come from these tokens so it stays coherent.

The type scale is deliberately one notch above Tailwind's default (`text-xs` is
13px, `text-sm` 15px, `text-base` 17px). Don't "fix" a size that looks big by
the default scale's numbers.

## Where classes live

The frontend is vanilla JS: much of the markup is built in `public/developer.js`
and `public/settings.js` as template strings. When searching for who uses a
class, grep `public/`, not just the HTML files.
