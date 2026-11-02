# The Android app

The Android app is the same SvelteKit app inside Capacitor. Its git traffic still
goes through the relay at `gitnote.miti99.dev`. Android builds need the Android SDK,
so they run on a PC with Android Studio or in GitHub Actions.

## What differs from the web

- **Page origin.** The WebView is `https://localhost`, which the relay's
  `CORS_ORIGINS` allows. `app/src/lib/platform/native.js` gives the relay's full
  address to the GitHub sign-in and to git.
- **Sign-in** opens in a Custom Tab, never in the WebView, and returns through
  `gitnote://oauth/callback`. PKCE and `state` make a code useless to another app
  claiming that scheme. Both ways Android delivers the link are handled:
  `appUrlOpen`, and `getLaunchUrl` when the callback starts the app. Any website or
  app can fire that link. One this device is not waiting for keeps the open page and
  the pending sign-in, makes no call to close the Custom Tab, and only shows a notice.
  Android may still drop the tab, because the link brings the `singleTask` activity
  forward, so the user may need to tap sign-in again. Android repeats the launch URL
  when it recreates the task from Recents, so an unawaited launch URL shows nothing.
- **Tokens** are in `@aparajita/capacitor-secure-storage`, encrypted with an Android
  Keystore key. Its file is left out of backups by `backup_rules.xml` and
  `data_extraction_rules.xml`, because a new device does not get the key. Notes and
  clones in the WebView's storage (`app_webview/`) are left out too, so private repo
  content never reaches a backup; a new device signs in and clones again.
  A record whose key is lost for good reads as signed out. Any other Keystore failure
  shows as a storage error and leaves the record in place.
- **Content Security Policy.** The build uses `CAP_BUILD=1`, which sets `script-src`
  to `'self' 'unsafe-inline'`, because Capacitor can inject its bridge as a nonce-less
  inline script. DOMPurify is therefore the only XSS defence on Android.
- **Autosave.** The app's `pause` and `resume` events act like going hidden and
  coming back: `pause` commits locally and `resume` pushes.
- **Repository list.** Links to other sites, such as installing the GitHub App, open
  in the device's browser. `resume` re-reads the list, so new repositories show up on
  return.
- **WebView version.** `minWebViewVersion` is 120, the first with `URL.canParse`. On
  an older WebView, Capacitor loads `app/static/webview-outdated.html`, which asks the
  user to update it.

`npm run e2e` runs this build in Chromium through `app/e2e/native-shell.js`: the real
bridge script and the real relay, with only the plugins' Java side stood in for. It
does not replace a device test.

## Never deploy a native build

`webDir` is `app/build`, the directory the Worker deploys, and a native build has the
weaker policy. Deploy with `npm run deploy`, which builds the web app first. Wrangler
also runs `app/scripts/check-deployable-build.js` as its build command, so a bare
`wrangler deploy` from a native build stops with an error, as does `npm run e2e`.

## Run it on a device

The app needs the relay deployed at `gitnote.miti99.dev` for sign-in and git. On a PC
with Android Studio, a JDK 21 and a device or emulator:

```sh
npm ci
# Sign-in buttons need these IDs; see sign-in-apps.md. Pasting a token works without.
npm run android:sync
npx cap run android
```

`npx cap open android` opens the project in Android Studio instead.

Then check on the device:

1. Sign in with GitHub and with GitLab. The Custom Tab closes and the repo list shows,
   with no blank or frozen overlay left on top.
2. Clone a repo, edit a note, commit, push and pull.
3. Turn on autosave in Settings, edit a note, and leave the app. Open the repo on
   github.com: nothing new. Return to the app: the commit arrives.
4. Force-stop the app during a sign-in, finish it in the browser, and confirm the
   app starts and completes it.
5. With a GitHub account that has not installed the App, tap **Choose which
   repositories gitnote can use** on the repo list and finish the install. The
   browser ends on the web app, where you are not signed in, which is expected.
   Return to the Android app: the repositories show up.
6. Check the layout on Android 15 or newer, where the app draws edge to edge: no
   heading, button or editor line sits under the status bar or the navigation bar.
7. Start a sign-in and, with the Custom Tab open, fire a link this device is not
   waiting for:

   ```sh
   adb shell "am start -a android.intent.action.VIEW -d 'gitnote://oauth/callback?code=x&state=none'"
   ```

   The app keeps its page and shows the ignored-link notice, and no account is added.
   Note whether the Custom Tab survives. If it closes, tapping sign-in again must work.

## Release signing

The keystore stays off this repo. Create it once, on your own PC, in a folder outside
this checkout, and keep a backup: an APK signed with a new key cannot update an
installed app. Git ignores `*.jks` and `*.keystore` as a second line of defence.

```sh
keytool -genkeypair -v -keystore gitnote-release.jks -alias gitnote \
  -keyalg RSA -keysize 4096 -validity 10000
```

The secrets live in a GitHub environment that only `v*` tags can use. Create it once:

```sh
gh api -X PUT repos/tiennm99dev/gitnote/environments/android-release \
  -F 'deployment_branch_policy[protected_branches]=false' \
  -F 'deployment_branch_policy[custom_branch_policies]=true'
gh api -X POST repos/tiennm99dev/gitnote/environments/android-release/deployment-branch-policies \
  -f name='v*' -f type=tag
```

Then add the secrets, from the folder holding the keystore:

```sh
base64 -w 0 gitnote-release.jks | gh secret set ANDROID_KEYSTORE_BASE64 -R tiennm99dev/gitnote --env android-release
gh secret set ANDROID_KEYSTORE_PASSWORD -R tiennm99dev/gitnote --env android-release
gh secret set ANDROID_KEY_ALIAS -R tiennm99dev/gitnote --env android-release --body gitnote
gh secret set ANDROID_KEY_PASSWORD -R tiennm99dev/gitnote --env android-release
```

That `keytool` command makes a PKCS12 keystore, which has one password, so give
`ANDROID_KEY_PASSWORD` the same value as `ANDROID_KEYSTORE_PASSWORD`.

In PowerShell, replace the first secret line with:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("gitnote-release.jks")) | gh secret set ANDROID_KEYSTORE_BASE64 -R tiennm99dev/gitnote --env android-release
```

Add the public sign-in IDs as repository variables:

```sh
gh variable set VITE_GITHUB_CLIENT_ID -R tiennm99dev/gitnote --body <GitHub App client ID>
gh variable set VITE_GITHUB_APP_SLUG -R tiennm99dev/gitnote --body <GitHub App URL name>
gh variable set VITE_GITLAB_CLIENT_ID -R tiennm99dev/gitnote --body <gitlab.com Application ID>
```

## Releasing

Pushing a `v*` tag runs `.github/workflows/android.yml`. One job builds an unsigned
APK with no secrets and a read-only token. A second job, on a fresh machine that runs
no npm or Gradle code, signs that file with the SDK's `apksigner`, checks it has a v2
or v3 signature, and attaches it to the release. So a compromised dependency could
tamper with one build but cannot steal the key, which could never be replaced. A tag
with a hyphen becomes a prerelease. The version name comes from the tag and the
version code from the workflow's run number.

```sh
git tag v0.1.0-beta.1
git push origin v0.1.0-beta.1
```

To check an APK yourself:

```sh
apksigner verify --print-certs --verbose gitnote-v0.1.0-beta.1.apk
```

A push to `main` that touches the Android project builds an unsigned debug APK, with
no secrets, to catch a broken Gradle project before a tag does.
