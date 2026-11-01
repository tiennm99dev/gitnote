# Registering the sign-in apps

gitnote signs in through a GitHub App and a gitlab.com OAuth application. Both
are registered by hand, once, by whoever runs the deployment. Until then the
sign-in buttons stay off and pasting a token still works.

The values below are for the live deployment at `gitnote.miti99.dev`. If you
run your own, use your own domain in the URLs; the Worker's route and the app's
CSP (`app/vite.config.js`) need the same change.

## GitHub App

Create it at **GitHub > Settings > Developer settings > GitHub Apps > New
GitHub App**. It must be public: a private App installs only on the account
that owns it.

| Setting | Value |
| --- | --- |
| GitHub App name | `gitnote` (names are global; pick another if it is taken) |
| Homepage URL | `https://github.com/tiennm99dev/gitnote` |
| Callback URL 1 | `https://gitnote.miti99.dev/auth/callback` |
| Callback URL 2 | `http://localhost:5173/auth/callback` |
| Callback URL 3 | `gitnote://oauth/callback` (the Android app) |
| Expire user authorization tokens | **On** (8-hour tokens with a refresh token) |
| Request user authorization (OAuth) during installation | Off |
| Enable Device Flow | Off |
| Setup URL | `https://gitnote.miti99.dev/repos`, with **Redirect on update** on |
| Webhook > Active | **Off** |
| Repository permissions > Contents | **Read and write** |
| Repository permissions > Metadata | Read-only (GitHub sets this itself) |
| Organization and account permissions | None |
| Where can this GitHub App be installed? | **Any account** |

Then, on the App's page:

1. Copy the **Client ID**, and note the App's URL name (the slug in
   `github.com/apps/<slug>`).
2. **Generate a new client secret** and copy it. GitHub shows it once.
3. Choose **Install App**, pick the account, then **Only select repositories**
   and pick the repositories to use. The repo picker lists only those.

## gitlab.com OAuth application

Create it at **gitlab.com > User settings > Applications > Add new
application**.

| Setting | Value |
| --- | --- |
| Name | `gitnote` |
| Redirect URI | The three lines below |
| Confidential | **Off**: the app is a public client using PKCE, with no secret |
| Scopes | `read_user`, `read_api`, `write_repository` |

```text
https://gitnote.miti99.dev/auth/callback
http://localhost:5173/auth/callback
gitnote://oauth/callback
```

Copy the **Application ID**. GitLab also shows a secret; gitnote does not use
it.

## Putting the values in place

The IDs are public and are built into the app. Blank ones turn that provider's
sign-in button off.

| Name | Value | Used by |
| --- | --- | --- |
| `VITE_GITHUB_CLIENT_ID` | GitHub App client ID | App build |
| `VITE_GITHUB_APP_SLUG` | GitHub App URL name | App build, for its install link |
| `VITE_GITLAB_CLIENT_ID` | gitlab.com Application ID | App build |
| `GITHUB_CLIENT_ID` | GitHub App client ID | Relay Worker secret |
| `GITHUB_CLIENT_SECRET` | GitHub App client secret | Relay Worker secret |

- **Building locally:** put the three `VITE_` values in `app/.env.local`, which
  git ignores, or set them in the environment of `npm run build`.
- **Relay in production**, from `relay/`:

  ```sh
  npx wrangler secret put GITHUB_CLIENT_ID
  npx wrangler secret put GITHUB_CLIENT_SECRET
  ```

- **Relay in local development:** put the two `GITHUB_` values in
  `relay/.dev.vars`, which git ignores. Run `npm run dev:relay` and `npm run dev`,
  and sign in at `http://localhost:5173`.

The GitLab flow runs on the device and needs nothing on the relay.

## Checking it worked

1. Open `/connect` and choose **Sign in with GitHub**. You land on `/repos`
   listing the repositories the App is installed on.
2. Pick one and clone it. It appears under **On this device**.
3. Repeat with **Sign in with GitLab**.
4. In the browser's developer tools, open the `gitnote-auth` IndexedDB database.
   Its `tokens` store holds only encrypted bytes.
