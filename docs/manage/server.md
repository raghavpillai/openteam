# Server commands

Run these commands on the machine that hosts OpenTeam. They manage the server installation; they do not require the desktop app to be open.

## Manage the stack

| Command | Use it to |
| --- | --- |
| `openteam status` | Check the installed version, server address, and service health |
| `openteam doctor` | Diagnose setup, connection, storage, and model-access problems |
| `openteam start` | Start the server and wait for it to become ready |
| `openteam stop` | Stop the containers while keeping data |
| `openteam logs --follow` | Follow service logs |
| `openteam setup` | Reconnect or change the model provider |
| `openteam setup --advanced` | Change network and installation settings |
| `openteam model` | Open the model and transcription editor |
| `openteam update` | Update the CLI and server |

Add `--dir /path/to/installation` when using a nondefault installation. Use `openteam <command> --help` for its options.

## Check a problem

Start with `openteam status`. If a service is unhealthy or a task cannot run, use `openteam doctor` for more detail.

Doctor sends a small request to the selected model provider and uses normal provider usage. It diagnoses problems without automatically starting a stopped server or changing its settings.

For a focused log view:

```sh
openteam logs --service server --follow --tail 200
```

## Change your account

```sh
openteam account update
```

This prompts for new credentials and signs out existing sessions. Use `--username <name>` or `--password` to change only one value.

## Uninstall

```sh
openteam uninstall
```

A normal uninstall removes containers but keeps configuration and persistent data. `openteam start` can recreate that installation.

`openteam uninstall --purge` also permanently deletes the installation's data and backups. Make a separate [backup](backups.md) first if you want a way to recover it.
