# Backup and restore commands

Back up PostgreSQL, all persistent volumes, and the installation secrets as one recovery set.

## Backups and restore

Everything OpenTeam needs lives in PostgreSQL plus five Docker volumes:

| Store | Holds |
| --- | --- |
| PostgreSQL (`openteam_postgres`) | Bots, chat history, runs, mailboxes, job queue, plugin state |
| `openteam_computer_home` | Provider credentials, Pi sessions, screen mappings, browser profiles |
| `openteam_agent_data` | Editable bot files: profiles, memory, routines, skills, transcripts |
| `openteam_assets` | Uploaded and generated attachments |
| `openteam_workspace` | The shared `/workspace` files |
| `openteam_box_store` | Snapshot blobs and their manifest |

They form one recovery set. Always back up and restore them together. For the cleanest backup,
stop sending messages and let active runs finish first. The names above are the keys in the Compose
file; Docker prefixes the project name, so `docker volume ls` shows them as
`openteam_openteam_postgres`, `openteam_openteam_workspace`, and so on. A dev stack from the repo
uses project `openteam-dev`, so its volumes are `openteam-dev_openteam_*`, and every container
carries a `com.openteam.environment` label of `production` or `development`, so the two never
collide on one machine.

Volumes belong to the Docker engine that created them. Switching Docker contexts or VM backends
does not move the volumes or their data. Back up this recovery set on the old engine and restore
it on the new one before removing the old backend.

## Back up a released install

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

Also copy `~/.openteam/.env`. It holds the database password and signing secrets the restored
data expects. For the dev stack, `sh scripts/backup.sh` in the repo does the same thing; run it
with `PROJECT=openteam` to back up a CLI install from a checkout instead.

## Restore

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
