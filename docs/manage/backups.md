# Backups and restore

Back up the full installation before moving hosts, replacing your Docker environment, or making changes you need to recover from.

## What to keep

OpenTeam's data is spread across the database and persistent Docker volumes. Keep them together as one recovery set.

| Data | Includes |
| --- | --- |
| Database | Bots, conversations, task history, and plugin configuration |
| Computer home | Browser profiles, saved model sign-ins, and runtime sessions |
| Agent data | Memory, profiles, routines, and skills |
| Workspace | Files created or used by bots |
| Assets and snapshot store | Attachments and stored file data |
| Installation configuration | The Compose file, installation record, and `.env` secrets |

A database dump alone is not a complete backup. The backup made during a server update is primarily for update rollback.

## Make a backup

Let active work finish and pause recurring work while taking the backup. Use a private destination with enough space, then follow the [backup commands](../reference/backup-commands.md#back-up-a-released-install) for the default released installation.

Keep the resulting files outside the Docker volumes being backed up. Protect them like account credentials: browser sessions, model sign-ins, and connected-account data may be included.

## Restore or move to another machine

Use the matching database dump, volumes, and configuration from the same backup. Restore into the intended installation before sending new tasks. The [restore procedure](../reference/backup-commands.md#restore) replaces its target data, so confirm the destination first.

Afterward, run `openteam status` and check a bot's history, memory, and files. Test the accounts and network address you plan to use. A new host may require updated app URLs and plugin callbacks.

## Changing Docker environments

Volumes belong to the Docker engine that created them. Switching Docker contexts or VM backends does not move the data automatically. Restore the complete backup on the new engine before removing the old one.

Ordinary restarts preserve data. Deleting volumes or using `openteam uninstall --purge` removes it.
