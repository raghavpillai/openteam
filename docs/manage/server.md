# Server commands

Manage your server with the `openteam` command on the host.

## Common commands

| Command | What it does |
| --- | --- |
| `openteam status` | Shows the server URL, version, and health of each service |
| `openteam doctor` | Checks for setup, connection, storage, and model problems |
| `openteam start` | Starts the server and waits until it's ready |
| `openteam stop` | Stops the server. Your data is kept. |
| `openteam logs --follow` | Streams logs from all services |
| `openteam setup` | Reruns guided setup, for example to change your model provider |
| `openteam setup --advanced` | Changes connection, port, time zone, and tasks at once |
| `openteam model` | Chooses the model, reasoning level, and voice transcription |
| `openteam provider` | Signs in to, signs out of, or adds model providers |
| `openteam account update` | Changes your username or password |
| `openteam update` | Updates the server and the CLI |
| `openteam uninstall` | Removes the server containers and CLI while preserving configuration and data |

Run `openteam <command> --help` for options. If you installed to a different directory, add `--dir <path>`.

## Diagnose a problem

Start with `openteam status`. If a service isn't healthy or bots aren't responding, run `openteam doctor`. It explains each failed check and what to do. Doctor sends one short request to your model provider, which counts toward your usage. It doesn't start services or change your settings.

To see logs for one service:

```sh
openteam logs server --follow
```

The main services are `server`, `worker`, `computer`, and `postgres`, plus `caddy` if you use automatic HTTPS.

## Change your account

```sh
openteam account update
```

This asks for a new username and password, and signs out every connected app. To change only one, add `--username <name>` or `--password`.

## Uninstall

```sh
openteam uninstall
```

This removes the containers and the `openteam` CLI, but keeps your data and configuration. Run the installer again to restore the CLI and bring the server back with the preserved data.

To delete everything, including your bots, conversations, files, and update backups:

```sh
openteam uninstall --purge
```

This can't be undone. Make a [backup](backups.md) first if you might want your data back. Both uninstall modes remove the `openteam` CLI; on Windows, deletion completes immediately after the running CLI process exits.
