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

Bots pause briefly while the server restarts. You need at least 4 GB free on the drive that holds your install directory. Closing the terminal doesn't stop an update; run `openteam update` again to check on it.

If the new version doesn't start, the updater rolls back to the previous version and restores the database. That backup covers the database only, not workspace files, browser sign-ins, or attachments. Keep your own [backups](backups.md).

## Update from the desktop app

Open **Settings → Updates** to update the desktop app. It can also update the server when the app runs on the server host, connects to it at `http://localhost:<port>` or `http://127.0.0.1:<port>` (your API port), and OpenTeam is installed in the default directory. Otherwise, it offers **Copy server command** so you can run the update yourself. When the app does update the server, it uses its own bundled CLI, so run `openteam update` on the host afterward to update the host's CLI too.

For a server on another machine, you can give the app an SSH destination so it can run the update for you. This needs SSH key sign-in that works without a password prompt, such as through an SSH agent. The host must already be in your `known_hosts` file, `openteam` must be on the `PATH` for non-interactive SSH sessions, and OpenTeam must be installed in the default directory. Otherwise, run `openteam update` on the server yourself.

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
