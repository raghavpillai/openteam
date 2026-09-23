# Server commands

Manage your server with the `openteam` command on the host. The desktop app doesn't need to be open.

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
| `openteam uninstall` | Removes the server containers |

Run `openteam <command> --help` for options. If you installed to a different directory, add `--dir <path>`.

## Diagnose a problem

Start with `openteam status`. If a service isn't healthy or bots aren't responding, run `openteam doctor`. It explains each failed check and what to do. Doctor sends one short request to your model provider, which counts toward your usage. It doesn't start or change anything.

To see logs for one service:

```sh
openteam logs server --follow
```

The services are `server`, `worker`, `computer`, and `postgres`.

## Change your account

```sh
openteam account update
```

This asks for a new username and password, and signs out every connected app. To change only one, add `--username <name>` or `--password`.

## Uninstall

```sh
openteam uninstall
```

This removes the containers but keeps your data and configuration. Run `openteam start` to bring the server back.

To delete everything, including your bots, conversations, files, and update backups:

```sh
openteam uninstall --purge
```

This can't be undone. Make a [backup](backups.md) first if you might want your data back. Neither command removes the `openteam` CLI itself.
