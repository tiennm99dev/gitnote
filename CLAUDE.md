# gitnote: agent notes

Offline-first git-backed markdown notes. npm workspaces: `app/` (SvelteKit 3
SPA, Svelte 5 runes, Tailwind 4) and `relay/` (Hono Worker). Commands and
tooling notes: [README.md](README.md).

## Commands

- Verify before every commit:
  `npm run lint && npm run typecheck && npm test && npm run build`.
  Add `npm run e2e` when touching routes, layout, build config or anything the
  browser loads.
- Fixed ports with `strictPort`: dev 5173, preview 4173, `wrangler dev` 8787.
  If a port is busy, stop the stale server instead of picking another port.
  `npm run e2e` builds and serves its own preview on 4173, so stop any
  running preview first.

## Rules

- Plain JavaScript with JSDoc types. Never add `.ts` or `.d.ts` files.
  Lint, `svelte-check` and the relay `tsc` check must end with zero warnings.
- npm only, one lockfile. Use caret ranges in `package.json`; exact versions
  live only in `package-lock.json`. A new package with an install script
  needs an explicit `allowScripts` entry.
- Keep one Vitest major across both workspaces (see the README for why).
- SvelteKit 3: kit options go in `app/vite.config.js`; import shared app
  modules through `#lib`, not `$lib`. Keep `ssr = false` and
  `prerender = false` in the root layout.
- The Worker stores nothing about users: no KV, D1, R2, or logging of request
  headers or bodies. Never log a token.
- Never commit secrets, `.dev.vars`, `.env` files or local machine paths.
- Conventional Commits, with no AI attribution. Push verified work straight to
  `main` (no PRs).
