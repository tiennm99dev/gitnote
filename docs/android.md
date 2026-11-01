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
  `appUrlOpen`, and `getLaunchUrl` when the callback starts the app. Android repeats
  the launch URL when it recreates the task from Recents, so a launch URL whose
  sign-in is no longer awaited is dropped quietly.
- **Tokens** are in `@aparajita/capacitor-secure-storage`, encrypted with an Android
  Keystore key. Its file is left out of backups by `backup_rules.xml` and
  `data_extraction_rules.xml`, because a new device does not get the key. Notes and
  clones in the WebView's storage are not excluded, so Android backups can hold them.
- **Content Security Policy.** The build uses `CAP_BUILD=1`, which sets `script-src`
  to `'self' 'unsafe-inline'`, because Capacitor can inject its bridge as a nonce-less
  inline script. DOMPurify is therefore the only XSS defence on Android.
- **Autosave.** The app's `pause` and `resume` events act like going hidden and
  coming back: `pause` commits locally and `resume` pushes.

`npm run e2e` runs this build in Chromium through `app/e2e/native-shell.js`: the real
bridge script and the real relay, with only the plugins' Java side stood in for. It
does not replace a device test.

## Never deploy a native build

`webDir` is `app/build`, the directory the Worker deploys, and a native build has the
weaker policy. After `npm run android:sync`, run `npm run build` before deploying.
`npm run e2e` fails while that directory holds a native build.

## Run it on a device

On a PC with Android Studio, a JDK 21 and a device or emulator:

```sh
npm ci
# Sign-in buttons need these IDs; see sign-in-apps.md. Pasting a token works without.
npm run android:sync
npx cap run android
```

`npx cap open android` opens the project in Android Studio instead.

Then check on the device:

1. Sign in with GitHub and with GitLab. The Custom Tab closes and the repo list shows.
2. Clone a repo, edit a note, commit, push and pull.
3. Turn on autosave in Settings, edit a note, and leave the app. Open the repo on
   github.com: nothing new. Return to the app: the commit arrives.
4. Force-stop the app during a sign-in, finish it in the browser, and confirm the
   app starts and completes it.

## Release signing

The keystore stays off this repo. Create it once, on your own PC, and keep a backup:
an APK signed with a new key cannot update an installed app.

```sh
keytool -genkeypair -v -keystore gitnote-release.jks -alias gitnote \
  -keyalg RSA -keysize 4096 -validity 10000
```

Add the secrets, from the folder holding the keystore:

```sh
base64 -w 0 gitnote-release.jks | gh secret set ANDROID_KEYSTORE_BASE64 -R tiennm99dev/gitnote
gh secret set ANDROID_KEYSTORE_PASSWORD -R tiennm99dev/gitnote
gh secret set ANDROID_KEY_ALIAS -R tiennm99dev/gitnote --body gitnote
gh secret set ANDROID_KEY_PASSWORD -R tiennm99dev/gitnote
```

In PowerShell, replace the first line with:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("gitnote-release.jks")) | gh secret set ANDROID_KEYSTORE_BASE64 -R tiennm99dev/gitnote
```

Add the public sign-in IDs as repository variables:

```sh
gh variable set VITE_GITHUB_CLIENT_ID -R tiennm99dev/gitnote --body <GitHub App client ID>
gh variable set VITE_GITHUB_APP_SLUG -R tiennm99dev/gitnote --body <GitHub App URL name>
gh variable set VITE_GITLAB_CLIENT_ID -R tiennm99dev/gitnote --body <gitlab.com Application ID>
```

## Releasing

Pushing a `v*` tag runs `.github/workflows/android.yml`. It builds and signs the APK,
checks it has a v2 or v3 signature, and attaches it to the release. A tag with a
hyphen becomes a prerelease. The version name comes from the tag and the version code
from the workflow's run number.

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
