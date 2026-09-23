# Server settings

Guided setup covers most installations. This page shows where to change each setting afterward.

## Where to change what

| Setting | Where to change it |
| --- | --- |
| Model provider, model, and reasoning level | Desktop **Settings → Server**, or `openteam model` |
| Web search and page fetching | Desktop **Settings → Server** |
| Voice transcription | Desktop **Settings → Server**, or `openteam model` |
| Connection mode, port, time zone, and tasks at once | `openteam setup --advanced` |
| Username and password | `openteam account update` |
| Accounts your bots use | **Marketplace** in the desktop app |

Model, search, and transcription changes apply to the next task. Changes made with `openteam setup --advanced` restart the services they affect, which interrupts running tasks.

## Change setup options

Run this on the server host:

```sh
openteam setup --advanced
```

Advanced setup lets you change the [connection mode](remote-access.md), server port (default `8787`), time zone, and tasks at once. Running setup again keeps your account and data.

**Time zone.** Setup uses the host's time zone. Routines run on the time zone saved with each routine, and fall back to the server's time zone.

**Tasks at once.** This limits how many bots can work at the same time. The default is the number of CPU cores on the host, up to 8. Lower it if the host runs out of memory or your model provider rejects parallel requests. Each bot always handles its own messages one at a time.

## Configuration files

The [install directory](../getting-started/installation.md#where-openteam-is-installed) holds:

- `.env`: generated secrets and settings
- `compose.yaml`: the Docker services for your version
- `installation.json`: a record of how the server was installed

Setup and updates maintain these files, so change settings with the CLI instead of editing them. Don't put model API keys in `.env`; connect providers with `openteam setup` or in the app. Include this directory in your [backups](../manage/backups.md).

For less common options, such as running behind a proxy on another machine, see the [server configuration reference](../reference/server-configuration.md).
