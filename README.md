# Ischemic Stroke — Web

Production web build of the Ischemic Stroke clinical decision-support app.
PWA-installable, works offline once the app shell and CMS content have been
fetched at least once.

## Local development

This is a static, single-file site — no build step, no `package.json`.

```sh
python -m http.server 8000
```

Then visit `http://localhost:8000`. Any static file server works (Node's
`http-server`, `npx serve`, etc.). Service workers require the page be served
over `http://` or `https://`, not `file://`.

## Deployment

Designed to be served from GitHub Pages at
`https://fahim-mygithub.github.io/stroke-mgmt-web/`. The `manifest.webmanifest`
`scope` and `start_url` are pinned to `/stroke-mgmt-web/`, so adjust those if
you serve under a different path. The `.nojekyll` file disables Jekyll
processing on Pages (so files starting with `_` are served verbatim).

## Architecture

Cross-references the architecture rationale in
`../docs/plans/2026-04-27-stroke-mgmt-offline-pwa-design.md` (parent repo).

Two cache layers:

- **Service worker** — app shell (HTML, JS, icons, manifest) cache-first;
  CMS image bytes stale-while-revalidate; CMS JSON passthrough.
- **In-page IndexedDB cache** — single source of truth for CMS content
  (algorithms, articles, intro sequence, disclaimer, about-us,
  placeholder-image pool). Stale-while-revalidate per fetch.

## Bumping caches

When app-shell assets change, bump the `v1` suffix in:

- `service-worker.js` (`APP_SHELL_CACHE = 'stroke-mgmt-app-shell-v1'`)
- `manifest.webmanifest` (no version pin yet, but mention here for parity if added)

The `activate` step deletes any older `stroke-mgmt-app-shell-*` cache so old
clients pick up the new shell on their next reload.
