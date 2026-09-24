# Backup and restore commands

Where a released installation keeps its data, and why the backup procedure works the way it does. For the commands themselves, see [Backups and restore](../manage/backups.md).

## Identify the data

Everything OpenTeam needs lives in PostgreSQL, five Docker volumes, and the install directory (`.env`, `compose.yaml`, `installation.json`):

| Store | Holds |
| --- | --- |
| PostgreSQL (`openteam_postgres`) | Bots, chat history, runs, mailboxes, job queue, plugin state |
| `openteam_computer_home` | Provider credentials, Pi sessions, screen mappings, browser profiles |
| `openteam_agent_data` | Editable bot files: profiles, memory, routines, skills, transcripts, and model and transcription settings |
| `openteam_assets` | Uploaded and generated attachments |
| `openteam_workspace` | The shared `/workspace` files |
| `openteam_box_store` | Snapshot blobs and their manifest |

Back up and restore these stores together. The names above are the keys in the Compose
file; Docker prefixes the project name, so `docker volume ls` shows them as
`openteam_openteam_postgres`, `openteam_openteam_workspace`, and so on. A dev stack from the repo
uses project `openteam-dev`, so its volumes are `openteam-dev_openteam_*` and stay separate.
Both use screen ports 6200–6299 (and API port 8787 by default), so don't run them at the same time.

## Back up and restore a released install

The step-by-step commands are in [Backups and restore](../manage/backups.md#make-a-backup). They stop only `server`, `worker`, and `computer` so PostgreSQL stays up for `pg_dump`.

A restore removes the `openteam_postgres` volume and lets PostgreSQL initialize it again from the restored `.env`. `POSTGRES_PASSWORD` only applies when a data directory is first created, so restoring into a cluster made by a different installation leaves the server's `DATABASE_URL` password out of sync and every connection fails authentication. After restoring, run `openteam status`. If the password is out of sync, the `migrate` setup job fails and the server doesn't start; check `openteam logs migrate`.

For the development stack, `sh scripts/backup.sh` dumps the database and archives volumes; copy its configuration separately too.

The plain SQL dumps that `openteam update` writes to `<install>/backups/` can be restored with `psql` instead of `pg_restore`.
