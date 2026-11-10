# Updates

Update the server and the `openteam` CLI with one command, or manage server updates from **Settings → Updates** on desktop, iPhone, or iPad. The desktop and iOS apps have their own updates.

## Update the server

On the server host, run:

```sh
openteam update
```

The updater:

1. Downloads the new version and checks its signature.
2. Backs up the database.
3. Restarts the server on the new version.
4. Updates the `openteam` CLI once the new server is healthy.

Bots pause briefly while the server restarts. On the host, `openteam update` doesn't wait for working bots: once the new version is downloaded, it stops the services and interrupts any task in progress. To update only when no bot is working, run `openteam update --when-idle`. If a bot is working when the update starts, or just before the services stop, the update is refused and nothing changes.

Accounts that run on the bot computer, such as Gmail, Google Calendar and Google Drive, start again the next time a bot uses them; you don't need to reconnect them. You need at least 4 GB free on the drive that holds your install directory. Closing the terminal doesn't stop an update; run `openteam update` again to check on it.

If the new version doesn't start, the updater rolls back to the previous version and restores the database. That backup covers the database only, not workspace files, browser sign-ins, or attachments. After a successful update, the updater keeps the three newest [update backups](backups.md#update-backups) and deletes older ones. Keep your own [backups](backups.md).

## Disk use after updates

After a successful update, OpenTeam removes its own older container images. It keeps the images for the current and previous versions, and any image a container still uses. It never deletes your data, Docker volumes, or browser sign-ins.

Each container keeps up to three log files of 10 MiB each; older log lines are discarded. To change that, set `OPENTEAM_LOG_MAX_SIZE` and `OPENTEAM_LOG_MAX_FILES` in your install directory's `.env`, or `OPENTEAM_LOG_MAX_SIZE=-1` to turn rotation off. The new limits apply when containers are recreated; see [server settings](../configuration/server.md#configuration-files). To keep more or fewer update backups, see [update backups](backups.md#update-backups).

## Update from the desktop app

Open **Settings → Updates** to update the desktop app and the connected server. Under **Connected server**, the app shows the running server version. Choose **Update** and confirm to update that server to the installed desktop version. The version notice links directly to the relevant update. You can also open updates from **Settings → Server → Connected server → View updates**.

The desktop sidebar also shows available app updates and download progress. Choose **Restart to update** once the download is ready.

Server updates use your existing signed-in connection. They update that server's stack, including the worker, database migrations, and computer. No SSH destination or additional sign-in is needed. The app compares the server with the installed desktop even when it cannot check the desktop release feed.

The host CLI runs the same signed-release updater described above, including backup and rollback. While a bot is working, **Update** is turned off. For a bot named Scout, the app shows "Scout is still working. Update will be available when every agent is done." and a **Stop Scout** button; stop the bot or wait for it to finish. If a bot starts working before the services stop, the update is refused and nothing changes ("Nothing changed; try again when it's done."); choose **Update** again later. The update continues after you close the desktop app; the app reconnects when the server restarts.

The server saves the update job independently of either app. Reopen **Settings → Updates** on desktop or iOS to see its current status, including updates started from another device. If you reopen during a restart, the app shows the last known stage and when it was checked, then reconnects automatically. Live status replaces that snapshot; reopening never submits another update.

Both apps show the host's progress through preparation, download, backup, restart, and health checks. Completed stages have checkmarks; the current stage shows the server's live message. If the connection drops during restart, progress stays visible while the app reconnects. Recovery has its own status when the updater restores the previous version.

The CLI starts a background updater after `openteam install`, `openteam setup`, `openteam start`, or `openteam update`. On macOS and on Linux with systemd, it also sets the updater to start again after a reboot, so in-app updates keep working:

- **macOS:** a LaunchAgent in `~/Library/LaunchAgents` starts it when you sign in.
- **Linux:** a systemd user service starts it at boot. The CLI turns on lingering for your user so the service doesn't wait for you to sign in. If your system doesn't allow that, the CLI prints the `sudo loginctl enable-linger` command to run once.

`openteam stop` and `openteam uninstall` stop the updater and remove its startup entry; `openteam start` adds it back. On Windows, and on Linux without systemd, run `openteam start` after rebooting the host to re-enable in-app updates.

If the updater is unavailable, Settings shows the command to run on that server.

The desktop app and the server have separate versions. If the app reports that it's incompatible with the server, update both.

Updates keep the software bots installed on their computer; see [what restarts and updates keep](../usage/computer.md#what-restarts-and-updates-keep).

## Update from iPhone or iPad

Open **Settings → Updates**, or choose **View updates** in **Settings → Server**. Updates shows the installed iOS app version and the connected server version. If the server is older, choose **Update to <version>** and confirm. This uses your existing signed-in connection and the same host updater as desktop. While a bot is working, **Update to <version>** is turned off and the app shows "Waiting for Scout. The update is available when every bot is done." (with your bots' names). Unlike desktop, there's no button to stop the bot here. If a bot starts working before the services stop, the update is refused and nothing changes; try again later. The update continues if you close the app; reopen Updates to check progress.

Choose the **iOS app** row on the Updates page to open TestFlight for app updates. When a newer iOS release is available, the app also shows an **Update** badge and an **Update in TestFlight** notice. Manage the server's connected computers under **Settings → Server → Manage devices**.

## After updating

Run `openteam status`, then open the app and check that a bot's conversation and files are still there.

## Install a specific version

```sh
openteam update --version <version>
```

Downgrading, installing a prerelease, or reinstalling the current version need an extra flag. See `openteam update --help`.

## If an update fails

Read the error first. The usual causes are low disk space, a failed download, or a service that didn't start. The updater's full output, including Docker's, is in `update.log` in your [install directory](../getting-started/installation.md#where-openteam-is-installed); each update replaces it. Run `openteam doctor` to find the problem, fix it, and run the update again.

If `openteam --version` still shows the old version after an update, run the [installer](../getting-started/installation.md#install) again to replace the CLI.
