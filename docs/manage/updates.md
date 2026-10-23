# Updates

Update the server and the `openteam` CLI with one command. The desktop app updates separately.

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

Bots pause briefly while the server restarts. Accounts that run on the bot computer, such as Gmail, Google Calendar and Google Drive, start again the next time a bot uses them; you don't need to reconnect them. You need at least 4 GB free on the drive that holds your install directory. Closing the terminal doesn't stop an update; run `openteam update` again to check on it.

If the new version doesn't start, the updater rolls back to the previous version and restores the database. That backup covers the database only, not workspace files, browser sign-ins, or attachments. Keep your own [backups](backups.md).

## Update from the desktop app

Open **Settings → Updates** to update the desktop app. In **Settings → Computer → Connected server**, choose **Update** and confirm to update the server you are connected to. The request uses your existing signed-in connection. It updates that server's stack, including the worker, database migrations, and computer. No SSH destination or additional sign-in is needed.

The host CLI runs the same signed-release updater described above, including backup and rollback. Updates wait until every agent is idle; the host checks again before stopping services. The update continues after you close the desktop app; the app reconnects when the server restarts.

The CLI starts a background updater after `openteam install`, `openteam setup`, `openteam start`, or `openteam update`. After rebooting the host, run `openteam start` to re-enable in-app updates. If the updater is unavailable, Settings shows the command to run on that server. Servers installed before this feature need one update with `openteam update` on the host first.

The desktop app and the server have separate versions. If the app reports that it's incompatible with the server, update both.

## After updating

Run `openteam status`, then open the app and check that a bot's conversation and files are still there.

## Install a specific version

```sh
openteam update --version <version>
```

Downgrading, installing a prerelease, or reinstalling the current version need an extra flag. See `openteam update --help`.

## If an update fails

Read the error first. The usual causes are low disk space, a failed download, or a service that didn't start. Run `openteam doctor` to find the problem, fix it, and run the update again.

If `openteam --version` still shows the old version after an update, run the [installer](../getting-started/installation.md#install) again to replace the CLI.
