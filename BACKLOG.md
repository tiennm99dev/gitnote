# Backlog

Candidates, not commitments. Move an item to a plan once it is picked.

## Providers and transport

- **Custom git providers and self-hosted GitLab.** The web build can reach them only
  through the relay, and an any-host relay is an open proxy. It needs a guarded relay
  with app-signed requests and rate limiting, or native HTTP on Android after a spike on
  moving binary data across the bridge.
- **Native git transport on Android**, which would drop the relay and its 95 MB cap
  there.
- **Git LFS.** Today a file over the provider's limit is blocked.

## Android and platforms

- **https App Links for the Android OAuth callback**, replacing the custom scheme
  `gitnote://oauth/callback`.
- **Capacitor 9 migration.**
- **iOS.**

## Offline

- **Reload while offline on the web.** There is no service worker, so a reload with no
  network fails even though the notes are on the device. Android is not affected,
  because its files ship in the APK.

## Performance

- **Second tab during a pull.** A note opened or saved in another tab has been seen to
  take over 5 seconds on a loaded machine while tabs contend for stored files. The cause
  has not been measured.
