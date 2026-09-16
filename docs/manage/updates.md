# Updates

Update the desktop app and server from **Settings → Updates**, or use the CLI on the server host.

## Update the server and CLI

```sh
openteam update
```

Keep at least 4 GB of disk space free. The updater verifies the release, downloads its images, saves a database backup, and restarts the services. Expect a short interruption while the server switches versions.

The standalone CLI updates itself as part of this process. If an early CLI does not support self-update, run the installer once to replace it, then use `openteam update` for subsequent releases.

## Update from the desktop app

Open **Settings → Updates**. For a local installation, the app can run its bundled CLI. For a remote server, configure an SSH destination if you want the app to run the update there.

Remote updates require working SSH access with an existing host-key entry and an SSH agent. If that is not set up, run the displayed update command directly on the server.

Desktop app updates are separate from server updates. Check both entries, especially if the app reports a version incompatibility.

## After updating

Run `openteam status`, reconnect the app, and open a bot conversation. Confirm that its history and files are available before sending new work.

If the new server fails readiness checks, the updater attempts to restore the previous release and its database backup. That rollback backup is not a full copy of workspace files, browser profiles, or attachments. Keep your own [complete backups](backups.md).

## If an update fails

Read the reported failure before retrying. Common causes include low disk space, an unavailable image download, or a service that could not start. Use `openteam doctor` for the underlying problem.

To select a particular release, use `openteam update --version <version>`. Downgrades, prereleases, and reapplying the same release require explicit options; see `openteam update --help` before using them.
