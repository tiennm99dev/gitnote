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
| `relay/` | Hono Worker on Cloudflare Workers: serves the SPA through Static Assets and answers `/api/*` (see [Relay](#relay)) |

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
| `npm test` | Vitest in both workspaces; relay tests run inside workerd, and git engine tests go through the real relay to a local `git http-backend` |
| `npm run build` | Build the SPA into `app/build/` and dry-run the Worker bundle |
| `npm run e2e` | Playwright against a fresh production build, served by `vite preview` on port 4173 and as plain files (no CSP header) on port 4174, plus the git engine on LightningFS through the relay on port 8789 |

For local work, run `npm run dev:relay` and `npm run dev` side by side.

`npm test` and `npm run e2e` need native `git` on the `PATH`, with its
`http-backend` command.

Playwright needs a browser once: `npx playwright install chromium`. To use a
system Chromium instead, set `CHROMIUM_PATH`, for example
`CHROMIUM_PATH=/usr/bin/chromium npm run e2e`.

## Relay

The Worker keeps nothing about users: no storage bindings, and Workers Logs,
traces and Logpush stay off (`relay/wrangler.jsonc`). Only `/api/*` runs the
Worker; every other path is a static asset, with unknown paths falling back to
`index.html`. The `workers.dev` and preview hostnames are off, so the app's own
domain is the only origin.

| Route | Does |
| --- | --- |
| `GET /api/health` | Liveness probe |
| `GET /api/git/<host>/<repo path>.git/info/refs?service=git-upload-pack` (or `git-receive-pack`) | Git smart-HTTP ref discovery |
| `POST /api/git/<host>/<repo path>.git/git-upload-pack` and `.../git-receive-pack` | Fetch and push; needs `Content-Length`, at most 95 MB (413 above it); body uncompressed or `Content-Encoding: gzip` (415 otherwise) |
| `POST /api/oauth/github/token` | GitHub App code exchange: JSON `{ code, code_verifier?, redirect_uri? }`, with `Content-Length`, at most 8 KB |
| `POST /api/oauth/github/refresh` | GitHub App token refresh: JSON `{ refresh_token }`, same limits |

- **Git hosts** come from the `GIT_HOSTS` var: `github.com,gitlab.com` over
  https. Loopback entries such as `localhost:8174` use http, for local test
  servers only. Other hosts, paths, methods and content types answer 403.
  github.com repos must be exactly `<owner>/<repo>.git`, and no path segment
  may be `-` (GitLab's web-route separator), so the relay never fetches a web
  page.
- **Responses.** A 2xx passes through only with the git content type for that
  endpoint (otherwise a JSON 502 `unexpected_upstream_response`), and an error
  status keeps its body only when it is `text/plain` (otherwise a JSON
  `upstream_error` with the same status). Every `/api/*` answer carries
  `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: default-src 'none'; sandbox; frame-ancestors 'none'`.
- **Headers.** Only `Authorization`, `Content-Type`, `Accept`, `Git-Protocol`
  and `User-Agent` go upstream, and a `User-Agent` that does not start with
  `git/` becomes `git/gitnote-relay`. Redirects are never followed: an
  upstream 3xx (a renamed repo) comes back as a JSON 502 `repo_moved`.
- **Origins.** `/api/*` answers the Worker's own origin and the origins in
  `CORS_ORIGINS` (`https://localhost`, the Capacitor WebView, which also gets
  CORS headers). Requests without `Origin` pass unless `Sec-Fetch-Site` says
  another site sent them. This stops browsers only; non-browser clients are
  bounded by the host allowlist and the rate limits.
- **Rate limits** per client IP (`cf-connecting-ip`): 300 requests a minute on
  `/api/*`, 10 on `/api/oauth/*`. They are per Cloudflare location and
  approximate.
- **Errors** are JSON: `{ "error": "<code>", "message": "..." }`.
- **Security headers** for the SPA live in `app/static/_headers`, because
  asset responses skip the Worker. The Content Security Policy is generated
  by SvelteKit (`csp` in `app/vite.config.js`) as a `<meta>` tag in the built
  `index.html`, so it also applies inside Capacitor.

For local work, `relay/.dev.vars` (gitignored) can extend the vars and hold
the GitHub App credentials, for example:

```sh
GIT_HOSTS=github.com,gitlab.com,localhost:8174
GITHUB_CLIENT_ID=<GitHub App client ID>
GITHUB_CLIENT_SECRET=<GitHub App client secret>
```

In production, set the credentials with `wrangler secret put GITHUB_CLIENT_ID`
and `wrangler secret put GITHUB_CLIENT_SECRET`.

## Git engine

`app/src/lib/git/` clones, reads, writes, commits, pulls and pushes a repo on
the device, with no UI. `createRepo` in `repo.js` takes the file system as a
parameter: LightningFS in the browser (`fs.js`), `memfs` in unit tests.

- **Shallow only once.** The clone uses `depth: 1`; later fetches pass no
  depth, because a depth-limited fetch leaves a diverged branch with no merge
  base.
- **Pull** runs only on a clean tree, and takes `signal` to cancel. Its fetch
  runs outside the repo lock, so saving a draft never waits for the network; a
  draft saved during the fetch makes the merge refuse, and the next pull reuses
  what was fetched. An ignored local file the remote now tracks refuses the
  pull with `checkout_conflict` before anything moves.
- **A conflict is a result, not an error.** The branch does not move. The index
  holds the merge's result with unmerged entries for the conflicted paths, and
  `status` lists those paths plus any edit made on top. isomorphic-git writes
  no `MERGE_HEAD`, so the merge is stored in `gitnote-merge.json` in the git
  directory, where a reload finds it. `merge.conflicts` says what each side did
  to each path (`both_modified`, `deleted_by_us`, `deleted_by_theirs`) and
  whether it is binary. Only `both_modified` text gets diff3 markers; a binary
  file or one side's deletion keeps one side's exact bytes. Files that are not
  valid UTF-8 count as binary, because a line merge would damage them.
- **Finishing a merge.** `resolveConflict` picks ours or theirs for a path,
  `completeMerge` makes the two-parent commit, refusing while markers remain
  unless `allowMarkers` is set, and `abortMerge` goes back to our commit and
  discards any resolution in progress. Never commit a merge any other way: the
  engine owns the merge's tree.
- **Interrupted work.** A pull records itself and flushes before it changes
  anything. If it fails, or the tab dies, the first later operation puts the
  branch, working tree and index back to our commit, and the next pull starts
  over. A clone counts only once `gitnote.defaultBranch` is written, its last
  step; a later `clone` clears what an interrupted one left.
- **Size limits** are a table in `limits.js`, checked before any network call:

  | Check | GitHub | GitLab.com |
  | --- | --- | --- |
  | Warn per file | over 50 MB | over 50 MB |
  | Block per file | over 100 MiB | over 95 MB (relay cap) |
  | Block per push | over 95 MB (relay cap) | over 95 MB (relay cap) |

  The push size is an estimate: the summed size of the blobs the unpushed
  commits add. It leaves out trees and commits, so a push just under the cap
  can still get a 413 from the relay, which is mapped to the same message.
- **Writes** go through `writeFile`, which swaps in a new file. isomorphic-git
  judges a file unchanged by size, whole-second mtime and inode, so writing in
  place could hide a same-size edit. The old file is deleted only after the new
  one is flushed, because LightningFS deletes an unlinked file's data at once.
- **Durability and locks.** Every operation except pull's fetch holds a per-repo
  Web Lock, and one that changes data flushes LightningFS's superblock before
  it resolves, so a commit survives the tab closing right after.
- **Credentials** never go in the repo. `clone` and `repoIdForUrl` refuse a URL
  with a username or token, which would otherwise be stored in plain text.

Failures are `GitEngineError`s with a stable `code` and a readable message
(`errors.js`).

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
- **Install scripts.** `allowScripts` in `package.json` lists every package
  in the lockfile that has an install script. `esbuild` and `workerd` may run
  theirs; `fsevents` (macOS only) is denied because it ships prebuilt
  binaries. Review a new one with `npm install-scripts ls` before approving
  it.
