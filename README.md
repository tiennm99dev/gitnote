# gitnote

Offline-first markdown notes stored in your own git repository, for the web
and Android. The app clones your GitHub or GitLab repo onto the device, shows
its markdown as notes, and commits and pushes only when you say so. The server
keeps nothing about users: a stateless Cloudflare Worker serves the app and
relays git traffic the browser cannot send directly.

Status: early development. You can connect an account, clone a repo, browse,
edit and search its notes on the device, then commit, pull and push them. The
web app is at <https://gitnote.miti99.dev>; the Android APK comes from
[GitHub Releases](https://github.com/tiennm99dev/gitnote/releases).

Offline-first has one gap on the web: reloading the page needs a network, because
there is no service worker yet. Notes you already have open keep working offline.

## Layout

| Path | What it is |
| --- | --- |
| `app/` | SvelteKit single-page app (Svelte 5, Vite, Tailwind 4), built with adapter-static |
| `relay/` | Hono Worker on Cloudflare Workers: serves the SPA through Static Assets and answers `/api/*` (see [docs/architecture.md](docs/architecture.md)) |
| `android/` | Capacitor's Android project around a native build of the SPA (see [docs/android.md](docs/android.md)) |

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
| `npm run e2e` | Playwright against a fresh production build in `app/build-e2e/` (never `app/build/`, which the Worker deploys, because this build holds fixture client IDs), served by `vite preview` on port 4173 and as plain files (no CSP header) on port 4174, the git engine on LightningFS through the relay on port 8789, and the sign-in, repo and notes pages with the providers' APIs stood in for and real git behind the relay. It also builds the Android bundle into `app/build-native-e2e/` and runs it behind Capacitor's real bridge script |
| `npm run e2e:live` | Playwright against the deployed site, with nothing stood in for (see [the live tests](docs/architecture.md#testing-against-the-live-site)) |
| `npm run android:sync` | Build the Android bundle into `app/build/` and copy it into `android/` (see [docs/android.md](docs/android.md)) |
| `npm run deploy` | Build the web app and deploy the Worker; wrangler refuses a directory holding an Android build |

For local work, run `npm run dev:relay` and `npm run dev` side by side.

`npm test` and `npm run e2e` need native `git` on the `PATH`, with its
`http-backend` command.

Playwright needs a browser once: `npx playwright install chromium`. To use a
system Chromium instead, set `CHROMIUM_PATH`, for example
`CHROMIUM_PATH=/usr/bin/chromium npm run e2e`.

## Privacy

The server keeps nothing about you. The Worker has no storage bindings, and its logs,
traces and Logpush are off (`relay/wrangler.jsonc`).

What the relay does see in transit, because it forwards the traffic: your git requests
with their `Authorization` header and repository contents, the GitHub sign-in codes and
refresh tokens it exchanges, and your IP address, which the rate limiter counts by.
None of it is written anywhere. Cloudflare terminates TLS for the relay, so using a
deployment means trusting whoever runs it and Cloudflare; run your own if you would
rather not (see [Self-hosting](#self-hosting)).

Your token goes only to the provider's API and, through the relay, its git host. Your
notes stay in your repo and on your device, with one exception on Android: the app
allows Android backups and leaves only the token file out, so clones and drafts, private
repos included, can reach your Google account's backup or a device transfer. Turn off
the device's backup if you do not want that.

## Supported providers

github.com and gitlab.com, by GitHub App or GitLab OAuth sign-in, or a pasted token for
either. Custom hosts, self-hosted GitLab and Git LFS are not supported; see
[BACKLOG.md](BACKLOG.md).

## Size limits

A file over 50 MB gets a warning. A file is blocked over 100 MiB on GitHub and over
95 MB on GitLab.com, and a push is blocked over about 95 MB, the relay's cap. All of
this is checked before any network call, and the message names the limit. The full
table is in [docs/architecture.md](docs/architecture.md#limits).

## Relay

Routes, data flow, storage and limits are in
[docs/architecture.md](docs/architecture.md).

For local work, `relay/.dev.vars` (gitignored) can extend the vars and hold the GitHub
App credentials, for example:

```sh
GIT_HOSTS=github.com,gitlab.com,localhost:8174
GITHUB_CLIENT_ID=<GitHub App client ID>
GITHUB_CLIENT_SECRET=<GitHub App client secret>
```

## Deploying

`.github/workflows/deploy.yml` publishes `main` after CI passes, then runs the live
tests. It only touches this Worker. It needs:

| Name | Kind | Value |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Secret | A token that can edit this account's Workers and the zone's Worker routes |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | The Cloudflare account ID |
| `VITE_GITHUB_CLIENT_ID`, `VITE_GITHUB_APP_SLUG`, `VITE_GITLAB_CLIENT_ID` | Variables | See [docs/sign-in-apps.md](docs/sign-in-apps.md); blank ones turn that sign-in button off |
| `GITNOTE_E2E_REPO`, `GITNOTE_E2E_TOKEN` | Variable, secret | See [the live tests](docs/architecture.md#testing-against-the-live-site); the note round trip is skipped without the variable, and the smoke tests always run |

The Worker's own secrets are set once, from `relay/`, with
`npx wrangler secret put GITHUB_CLIENT_ID` and
`npx wrangler secret put GITHUB_CLIENT_SECRET`.

To deploy by hand, run `npm run deploy` with the `VITE_` values in the environment. They
are built into the app, so a deploy without them removes the sign-in buttons from the
live site, with no warning, until the next deploy that has them.

## Self-hosting

1. Fork this repo and choose a domain on a Cloudflare zone you control.
2. Replace the live domain with yours in `routes` in `relay/wrangler.jsonc`. The app's
   `connect-src`, the Android build's relay and the tests all read it from there, so the
   live tests, and any token you give them, go to your deployment.
3. Change the repository name in the `if:` conditions of
   `.github/workflows/deploy.yml` and `.github/workflows/android.yml`.
4. Pick your own `namespace_id` values under `ratelimits` in `relay/wrangler.jsonc` if
   the account already uses those numbers.
5. Register your own GitHub App and gitlab.com application with
   [docs/sign-in-apps.md](docs/sign-in-apps.md), using your domain in the URLs.
6. Set the names under [Deploying](#deploying) and push to `main`, or run
   `npm run deploy` with the `VITE_` values in the environment.

## Commit and sync

`app/src/lib/sync/sync.js` holds the state behind the sync bar, the commit panel
(`CommitPanel.svelte`) and the merge list (`ConflictView.svelte`). It reports
failures in its state instead of throwing.

- **Commit.** Every changed file starts selected, with a line diff and a message
  built from the paths. Size warnings come from the engine's `checkCommit`, and a
  blocked file turns the commit buttons off. Unsaved text is not a change yet: the
  panel lists it and offers Save all. Discard goes back to the branch's commit and
  deletes a file the commit does not have. It refuses when restoring a file would
  delete a folder holding files that are not selected.
- **Author.** Settings (`/settings`) first, then the account's profile, then for
  GitHub `<login>@users.noreply.github.com`. With none of those, committing and
  merging ask for one. A pull still fetches and fast-forwards, which commits
  nothing, and stops only if it needs a merge.
- **Pull** runs on opening and on request, only on a clean tree. Local changes hold
  it back with a prompt to commit or discard; `fetchRemote` still updates the
  behind count. Drafts do not hold it back: if a pull changes such a file, the
  note asks which version to keep.
- **Conflicts.** The list comes back after a reload, from the engine's merge
  record. Conflicted text is edited in the ordinary note pane, so it keeps its
  drafts. A file counts as resolved once it has no markers and no unsaved text;
  markers that are really the file's content take an explicit choice. Binary files
  and files one side deleted take an ours/theirs choice. The merge commit is always
  the engine's `completeMerge`, and `abortMerge` is the way back. A symbolic link
  also takes an ours/theirs choice, and stays a link. If a conflict's details cannot
  be read, the list still shows it, unresolved, so the merge can be abandoned.
- **Push.** There is no force push. Offline, or on a connection failure, the push
  is queued in localStorage and goes on `online`, on coming back, on focus and on
  opening. A connection failure while the device reports a network gets no `online`
  event, so a visible page also retries, every 15 seconds at first and every 5
  minutes at most. An open merge holds a queued push, and completing, abandoning or
  resetting the merge sends it. With autosave on, autosave sends it and pulls first.
  Any other refusal is shown and not retried. A push over a size limit offers
  `undoUnpushedCommits`, which asks to turn autosave off first, because autosave
  would commit those files together again.
- **A damaged merge record** makes every engine call fail with
  `MERGE_STATE_DAMAGED`, so the sync bar offers `resetDamagedMerge`: the index
  returns to the branch and the files stay, as changes to commit or discard.
- **Autosave (beta, off by default)** is `app/src/lib/sync/autosave.js`. While the
  page is visible, every 1, 5, 10 or 30 minutes, it saves drafts, commits
  `autosave: <paths>`, pulls, then pushes. Going hidden commits on the device only;
  coming back, launching and regaining the network push. It stands aside while a
  merge is open and resumes by itself after. A draft whose file changed underneath
  it is left out and named, and so is a file over a size limit or with conflict
  markers in it (which a commit from the panel can still take), so the other notes
  still get committed. It is armed before the pull on opening, which can stall.
  Timers run reliably only in the foreground, so it does nothing while the app is
  in the background: on Android especially, a change made just before leaving the app
  is committed on the device and is not pushed until you come back. Autosave commits
  everything it can, under a generated message, so leave it off for a repo whose
  history you care about.

## Notes

`/repo/<id>/<path>` is the notes screen, with the repo id URL-encoded into one
segment. `app/src/lib/stores/notes.js` holds its state.

- **Where text lives.** The editor's buffer is copied to a draft in IndexedDB
  (`gitnote-drafts`) on every change, so a reload loses nothing. Save writes it
  to the working tree. Only a commit puts it in git, and only the commit panel
  or the autosave beta commits. A draft remembers the file it started from: if the file changes
  underneath it, the user chooses between the two, and neither is overwritten
  until they do. Deleting a copy counts its drafts in the warning and removes
  them with it. A draft counts as a file when renaming or creating: nothing moves
  onto one, or makes a folder of it.
- **When the browser refuses a draft.** The text then stays in memory, per path,
  through moving between notes and renaming, and the screen keeps listing it.
  Leaving the repository or the page asks first, since that would lose it.
- **Two tabs on one note.** Each tab keeps its own buffer and they share one
  draft. A tab removes a draft only while it still holds the text that tab
  stored, and a tab that regains focus stores its buffer again if the draft no
  longer matches. Closing a tab whose draft another tab replaced, without going
  back to it, loses that tab's unsaved text.
- **Bytes.** Line endings and a byte order mark survive open and save unchanged.
  A file over 5 MB, or one that is not valid UTF-8, shows its size only; a U+FFFD
  that is really in a note is ordinary text. A symbolic link is listed and says
  what it is, and is never followed. A note edited past 5 MB stays editable until
  it is closed. Pasted text takes the
  note's line ending; a note that mixes endings takes `\n`.
- **Rendering** (`app/src/lib/markdown/render.js`). markdown-it with raw HTML on,
  then DOMPurify, then image and link rewriting. Raw HTML keeps its structure but
  loses `style`, `class`, forms, media, dialogs, popovers and inline SVG, so a
  note cannot pose as the app. Front matter is left out only when its first line
  reads as YAML, so two horizontal rules keep the text between them. Headings get
  ids, and `#fragment` links point at them, with sanitizing's `user-content-`
  prefix.
  `blob:` URLs are made only for PNG, JPEG, GIF, WebP and SVG, and only land in an
  `<img>`. Remote images become links, because the CSP blocks them. Relative links
  open in the app.
- **Images** go to `assets/` next to the note, under a name not in use, after the
  per-file size check. A paste counts as an image only in a markdown note with no
  plain text on the clipboard.
- **Search** scans the working tree's markdown files in memory, ignoring case. A
  tracked name the engine refuses, such as one with a backslash, shows in the tree
  and reports why when opened, and search skips it.
- **A file list that cannot be read** shows above the note on every screen size.
  Notes still open from the file itself, and creating, moving, deleting, adding
  images and searching refuse rather than act on an old list. The engine's
  `createFile` also refuses an existing path, which covers another tab.

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
- **Push** checks under the repo lock, then sends the commit it checked under a
  separate network lock, so saving and reading never wait for the network. A
  commit made during the send waits for the next push. Pull's fetch uses the
  same network lock. A request or response that goes quiet for 60 seconds ends
  in a `network` error; a request with a body gets extra time to upload it.
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
  `completeMerge` makes the two-parent commit, refusing with
  `conflicts_unresolved` while markers remain (unless `allowMarkers` is set) or
  while a binary file or a one-sided delete is undecided. Picking a side, even
  the bytes already in place, or editing or removing the file decides it.
  `abortMerge` goes back to our commit and discards any resolution in progress;
  an edit `status` lists outside the conflicted paths stays as a draft. Never
  commit a merge any other way: the engine owns the merge's tree.
- **Interrupted work.** A pull records itself and flushes before it changes
  anything. If it fails, or the tab dies, the first later operation puts the
  branch, working tree and index back to our commit, and the next pull starts
  over. A clone counts only once `gitnote.defaultBranch` is written, its last
  step; a later `clone` clears what an interrupted one left. LightningFS
  overwrites existing files at once but records new files only at a flush, so
  objects are flushed before an index or ref names them, and a commit interrupted
  at any point leaves the repo working. A branch whose commit is missing anyway
  reports `repo_damaged`.
- **Size limits** are a table in `limits.js`, checked before any network call; the
  values are in [docs/architecture.md](docs/architecture.md#limits). Push sends the
  whole branch, so `commit` and `checkCommit` warn when a file alone is over the relay
  cap (GitHub's own file limit is higher, so it can commit) or when the unpushed total
  would pass it. `undoUnpushedCommits` is the way out: the branch returns to the
  remote-tracking commit and the working tree stays, so the changes can be committed
  again in smaller groups.
- **Writes** go through `writeFile`, which swaps in a new file. isomorphic-git
  judges a file unchanged by size, whole-second mtime and inode, so writing in
  place could hide a same-size edit. The old file is deleted only after the new
  one is flushed, because LightningFS deletes an unlinked file's data at once.
- **Durability and locks.** Every operation except pull's fetch and push's send
  holds a per-repo Web Lock, and one that changes data flushes LightningFS's superblock before
  it resolves, so a commit survives the tab closing right after.
- **Credentials** never go in the repo. `clone` and `repoIdForUrl` refuse a URL
  with a username or token, which would otherwise be stored in plain text.
- **Which branch.** `clone` takes the branch to check out as `ref`, or uses the
  remote's default without it. Later pulls and pushes stay on that branch.

Failures are `GitEngineError`s with a stable `code` and a readable message
(`errors.js`).

## Accounts

`/connect` signs in or takes a pasted token, `/repos` picks a repo and branch and
clones it, and `app/src/lib/auth/` holds the logic. Registering the GitHub App and
the gitlab.com application, and where their IDs go, is in
[docs/sign-in-apps.md](docs/sign-in-apps.md).

- **GitHub** uses a GitHub App: its code exchange and refresh need a client secret,
  so they go through the relay. **GitLab** uses PKCE with no secret, on the device.
  Both redirect with a one-use `state` that must match a sign-in this device
  started, and the code is cleared from the address bar at once.
- **Pasted tokens** are checked with `GET /user` and stored only if accepted. They
  cannot refresh. A pasted GitHub token lists repos through `/user/repos`, as it
  cannot call the installation endpoints.
- **Storage.** `token-store.js` encrypts each sign-in in IndexedDB with an AES-GCM
  key the browser will not export. This protects a copied database, not a script
  already running in the page; the CSP and sanitized rendering cover that. In the
  app's localStorage are only the list of local copies and, during a sign-in, its
  `state` and PKCE verifier.
- **Refresh.** Tokens refresh 5 minutes before expiry and on a 401. Both providers
  rotate refresh tokens, so every refresh holds a per-provider Web Lock and rereads
  the store inside it, and the new pair is stored in one write. A refresh that
  cannot be answered keeps the sign-in, and a token still in date stays in use.
  Only an explicit refusal of the refresh token (`bad_refresh_token`,
  `invalid_grant`) flags the sign-in as ended, and that never touches local clones.
  Any other answer, such as a blocked request or a wrong client secret, says nothing
  about the token, so it is tried again.
- **Where tokens go.** Only to the provider's API and, through the relay, its git
  host: `gitCredentials` refuses any other host, and clone URLs are built from the
  repo's path rather than taken from the API. The git username is `x-access-token`
  on GitHub and `oauth2` on GitLab.
- **Sign-out** deletes the provider's local copies only if asked, after showing
  each copy's unpushed commits and uncommitted files. Each copy is counted again
  under its repo lock in the same step that deletes it, so a commit from another tab
  can never be lost unseen: the confirmation asks again instead. Only then is the
  token removed, and a failed deletion keeps the sign-in so it can be retried.
  `/repos` can delete any copy on its own, with or without an account.
- **What deletion leaves.** Files are deleted one by one, because LightningFS's
  `wipe` breaks other open tabs, so the emptied IndexedDB database stays. Its name
  holds the repo's host and path (`gitnote:github.com/owner/repo`), so a private
  repo's name remains readable in the browser's storage until site data is cleared.

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
