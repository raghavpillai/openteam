# Backups and restore

Back up your server before you move it to another machine, change your Docker setup, or do anything you might need to undo.

## What's in a backup

Your data lives in a database and several Docker volumes. Back them up together, along with your install directory:

| What | Contains |
| --- | --- |
| Database | Bots, conversations, run history, plugin accounts, and private skills |
| `computer_home` volume | Browser profiles, website sign-ins, and model provider sign-ins |
| `agent_data` volume | Memory, skills, routines, bot profiles, and model settings |
| `workspace` volume | Files in `/workspace` |
| `assets` volume | Attachments |
| `box_store` volume | Snapshots of the bots' computer files |
| [Install directory](../getting-started/installation.md#where-openteam-is-installed) | Settings and generated secrets |

Backups include sign-ins to websites and services. Store them somewhere private.

The database backup that `openteam update` makes is for rolling back a failed update. It isn't a full backup.

## Make a backup

These commands work in Bash or zsh on macOS and Linux. They pause your bots while the backup runs, so let active work finish first.

```sh
D=~/.openteam
OUT=~/openteam-backup-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$OUT"
oc() { docker compose --project-name openteam --project-directory "$D" -f "$D/compose.yaml" "$@"; }

# Stop the bots, but keep the database running
oc stop server worker computer

# Back up the database
oc exec -T postgres pg_dump -U openteam -d openteam --format=custom > "$OUT/postgres.dump"

# Back up the volumes
for v in computer_home agent_data assets workspace box_store; do
  docker run --rm -v "openteam_openteam_$v:/source:ro" -v "$OUT:/backup" alpine:3.22 \
    tar -czf "/backup/openteam_$v.tar.gz" -C /source .
done

# Back up the install directory
cp "$D/.env" "$D/compose.yaml" "$D/installation.json" "$OUT/"

openteam start
```

If you installed OpenTeam somewhere else, set `D` to that directory: `$OPENTEAM_HOME` if you set it, `$XDG_CONFIG_HOME/openteam` if you set `XDG_CONFIG_HOME`, or the path you passed to `--dir` (then also run `openteam start --dir "$D"`). Keep backups outside the install directory.

If you use automatic HTTPS, your certificates aren't included. On a new machine, the proxy requests new ones once your domain points there.

## Restore a backup

Restoring replaces all the data in the target server. To move to a new machine, first [install OpenTeam](../getting-started/installation.md) there.

```sh
D=~/.openteam
OUT=~/openteam-backup-20260101T000000Z   # the backup to restore
oc() { docker compose --project-name openteam --project-directory "$D" -f "$D/compose.yaml" "$@"; }

# Stop the server and remove its current database
oc down
docker volume rm openteam_openteam_postgres

# Put back the install directory, then restore the database
cp "$OUT/.env" "$OUT/compose.yaml" "$OUT/installation.json" "$D/"
oc up -d --wait postgres
oc exec -T postgres pg_restore -U openteam -d openteam < "$OUT/postgres.dump"

# Restore the volumes
for v in computer_home agent_data assets workspace box_store; do
  docker run --rm -v "openteam_openteam_$v:/target" -v "$OUT:/backup:ro" alpine:3.22 \
    sh -c "find /target -mindepth 1 -delete && tar -xzf /backup/openteam_$v.tar.gz -C /target"
done

openteam start
```

The restore recreates the database so that it uses the password saved in your backup's `.env`. Then run `openteam status` and open a bot to check that its conversations, memory, and files are back.

On a new machine, the restored settings still use the old machine's address. Run `openteam setup --advanced` and enter the new address. If you use a domain name, you can point it at the new machine instead. Then update the server URL in your apps, and the callback URL for any plugin that uses one, such as [Google](../integrations/google.md) or [Slack](../integrations/slack.md).

## Changing Docker setups

Docker volumes belong to the Docker engine that created them. If you switch Docker contexts, reinstall Docker Desktop, or move to a different engine, your data doesn't come with you. Back up first, then restore on the new engine before removing the old one.

Restarting the server or the host keeps your data. Only deleting the Docker volumes or running `openteam uninstall --purge` removes it.
