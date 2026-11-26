# gitnote

> **Archived.** gitnote was a web and Android app for markdown notes kept in
> your own git repo. Existing tools already do this well, so the project
> stopped and its code was removed. The last commit with the code is
> [`7fbe43d`](https://github.com/tiennm99dev/gitnote/tree/7fbe43d).

Use [Obsidian](https://obsidian.md) with git instead: your notes stay plain
markdown files in a repo you own, with full history.

## Obsidian with git

1. Create a **private** repo on GitHub, GitLab or any git host, and clone it
   on your computer.
2. In Obsidian, choose **Open folder as vault** and pick the clone.
3. Settings → Community plugins: turn them on, then install and enable
   **[Git](https://github.com/Vinzent03/obsidian-git)** (Obsidian Git). It
   uses the git installed on your computer and its login.
4. In the Git plugin's settings, set **Auto commit-and-sync interval
   (minutes)**, for example 5, and keep **Pull on commit-and-sync** on. It
   then commits, pulls and pushes on its own.
5. Add a `.gitignore` for files Obsidian changes on every open:

   ```
   .obsidian/workspace*.json
   .obsidian/cache
   .trash/
   ```

Repeat steps 1–4 on every computer. Commit-and-sync pulls before it pushes,
so the computers stay in step through the repo.

### Phones

Obsidian Git also runs on mobile, through a JavaScript git, but its author
calls that mode very unstable: no SSH, and large vaults can run out of memory.
On a phone, prefer one of these:

- **[GitSync](https://github.com/ViscousPot/GitSync)** (Android and iOS): a
  native git client that syncs a folder with your repo in the background.
  Clone the repo with it and open that folder as the vault. Don't enable
  Obsidian Git on the same vault.
- **Self-hosted LiveSync**, below.

## Bonus: live sync with Self-hosted LiveSync

Git syncs on a timer. For edits that show up on every device within seconds,
add **[Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync)**,
which syncs through your own CouchDB server, with end-to-end encryption.

```
Devices: Obsidian + Self-hosted LiveSync
   │  live sync
   ▼
CouchDB (your server)
   │  live sync
   ▼
One always-on Obsidian + Self-hosted LiveSync + Obsidian Git
   │  commit and push
   ▼
Your git repo
```

1. Run CouchDB behind HTTPS. LiveSync's
   [server guide](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/setup_own_server.md)
   lists the settings it needs (login on every request, CORS for the Obsidian
   apps, large documents). Mobile Obsidian connects only over HTTPS with a
   valid certificate.
2. Run one Obsidian that stays on, such as a desktop that never sleeps or the
   [LinuxServer Obsidian image](https://docs.linuxserver.io/images/docker-obsidian)
   on a server. Make its vault a clone of your repo, and install both
   Self-hosted LiveSync and Obsidian Git there.
3. In LiveSync, enter the CouchDB URL with `https://`, your login, and a
   lowercase database name. Turn on end-to-end encryption and apply the
   **LiveSync** sync preset.
4. Add each other device with a Setup URI: on the always-on copy, run
   `Self-hosted LiveSync: Copy settings as a new Setup URI`, then open it from
   LiveSync's onboarding on the new device, in an empty vault.
5. Add LiveSync's settings file to `.gitignore`, because it holds your CouchDB
   login and encryption passphrase:

   ```
   .obsidian/plugins/obsidian-livesync/data.json
   ```

The devices then only run LiveSync and never touch git. The always-on copy is
the one git writer, so git never sees a conflict, and the repo keeps the full
history as a backup.
