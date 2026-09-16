# Backup and restore commands

Use these commands for the default released installation. Run them in **Bash** on the server host. For backup planning and moving Docker environments, see [Backups and restore](../manage/backups.md).

## Identify the data

Everything OpenTeam needs lives in PostgreSQL plus five Docker volumes:

| Store | Holds |
| --- | --- |
| PostgreSQL (`openteam_postgres`) | Bots, chat history, runs, mailboxes, job queue, plugin state |
| `openteam_computer_home` | Provider credentials, Pi sessions, screen mappings, browser profiles |
| `openteam_agent_data` | Editable bot files: profiles, memory, routines, skills, transcripts |
| `openteam_assets` | Uploaded and generated attachments |
| `openteam_workspace` | The shared `/workspace` files |
| `openteam_box_store` | Snapshot blobs and their manifest |

Back up and restore these stores together. The names above are the keys in the Compose
file; Docker prefixes the project name, so `docker volume ls` shows them as
`openteam_openteam_postgres`, `openteam_openteam_workspace`, and so on. A dev stack from the repo
uses project `openteam-dev`, so its volumes are `openteam-dev_openteam_*`, and every container
carries a `com.openteam.environment` label of `production` or `development`, so the two never
collide on one machine.

## Back up a released install

Pause routines, stop sending new work, and let active runs finish. Keep the application services stopped while copying data, with PostgreSQL running for the dump. Choose a private backup destination outside the installation directory and its Docker volumes.

```sh
D=~/.openteam
OUT=./openteam-backup-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$OUT"
docker compose --project-name openteam --project-directory "$D" -f "$D/compose.yaml" \
  exec -T postgres pg_dump -U openteam -d openteam --format=custom > "$OUT/postgres.dump"
for v in computer_home agent_data assets workspace box_store; do
  docker run --rm -v "openteam_openteam_$v:/source:ro" -v "$(cd "$OUT" && pwd):/backup" alpine:3.22 \
    tar -czf "/backup/openteam_$v.tar.gz" -C /source .
done
```

Copy the installation configuration into the same backup: `.env`, `compose.yaml`, `installation.json`, and any Compose overrides. The `.env` secrets must match the restored database and volumes. Keep this configuration copy private, then restart the application and re-enable the routines you paused.

For the development stack, `sh scripts/backup.sh` dumps the database and archives volumes; copy its configuration separately too.

## Restore

These commands **replace the target database and volume contents**. Confirm the installation directory, Docker context, and project first. Restore its saved configuration, and set `OUT` to the directory containing the matching `postgres.dump` and volume archives before running the block. `OUT` from a previous terminal session will not carry over.

```sh
D=~/.openteam; C="docker compose --project-name openteam --project-directory $D -f $D/compose.yaml"
openteam stop
$C up -d postgres
$C exec -T postgres dropdb -U openteam --force openteam
$C exec -T postgres createdb -U openteam openteam
$C exec -T postgres pg_restore -U openteam -d openteam < "$OUT/postgres.dump"
for v in computer_home agent_data assets workspace box_store; do
  docker run --rm -v "openteam_openteam_$v:/target" -v "$(cd "$OUT" && pwd):/backup:ro" alpine:3.22 \
    sh -c "find /target -mindepth 1 -delete && tar -xzf /backup/openteam_$v.tar.gz -C /target"
done
openteam start
```

Then check `openteam status`, open a bot, and confirm its history, memory, and workspace files are
back before sending new work.

The plain SQL dumps that `openteam update` writes can be restored with `psql` instead of
`pg_restore`.
