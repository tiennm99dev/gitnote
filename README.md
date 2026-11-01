# gitnote

Offline-first markdown notes stored in your own git repository, for the web
and Android. The app clones your GitHub or GitLab repo onto the device, shows
its markdown as notes, and commits and pushes only when you say so. The server
keeps nothing about users: a stateless Cloudflare Worker serves the app and
relays git traffic the browser cannot send directly.

Status: early development. Nothing works end to end yet.

## Layout

| Path | What it is |
| --- | --- |
| `app/` | SvelteKit single-page app (Svelte 5, Vite, Tailwind 4), built with adapter-static |
| `relay/` | Hono Worker on Cloudflare Workers for the `/api/*` routes; so far only `GET /api/health` |

## Requirements

- Node 24 (see `.nvmrc`) and npm 11. npm is the only package manager.

## Commands

Run from the repo root:

| Command | Does |
| --- | --- |
| `npm ci` | Install exactly what `package-lock.json` records |
| `npm run dev` | Vite dev server on port 5173; `/api` is proxied to port 8787 |
| `npm run dev:relay` | `wrangler dev` for the relay on port 8787 |
| `npm run lint` | ESLint (with `eslint-plugin-jsdoc` and `eslint-plugin-svelte`), zero warnings |
| `npm run typecheck` | JSDoc type check in both workspaces: `svelte-check` for the app, `tsc` against generated Worker types for the relay |
| `npm test` | Vitest in both workspaces; relay tests run inside workerd |
| `npm run build` | Build the SPA into `app/build/` and dry-run the Worker bundle |
| `npm run e2e` | Playwright against a fresh production build served on port 4173 |

For local work, run `npm run dev:relay` and `npm run dev` side by side.

Playwright needs a browser once: `npx playwright install chromium`. To use a
system Chromium instead, set `CHROMIUM_PATH`, for example
`CHROMIUM_PATH=/usr/bin/chromium npm run e2e`.

## Tooling notes

- **SvelteKit 3.** It reads no `svelte.config.js`: the kit and adapter
  options live in `app/vite.config.js`, and the `$lib` alias is `#lib`
  (declared under `imports` in `app/package.json`). The root layout sets
  `ssr = false` and `prerender = false`, and adapter-static writes an
  `index.html` fallback, so one build serves both the web and the Android
  shell.
- **One Vitest major.** Both workspaces use Vitest 5. The Workers test
  integration moved from `@cloudflare/vitest-pool-workers` (deprecated, Vitest
  4 only) to `@cloudflare/vitest-plugin`, which supports Vitest 5. Keeping one
  major also matters for npm workspaces: the plugin is hoisted to the root and
  resolves its `vitest` peer there, so a second major in `relay/` would run
  the plugin against the wrong Vitest.
- **Release-age delay.** `.npmrc` sets `min-release-age=3`. If an install
  fails with `ETARGET`, the newest release is younger than three days; use the
  previous version in the range.
- **Install scripts.** Only the packages listed under `allowScripts` in
  `package.json` (`esbuild`, `workerd`) may run install scripts. Review a new
  one with `npm install-scripts ls` before approving it.
