# Server settings

Guided setup covers most installations. This page shows where to change each setting afterward.

## Where to change what

| Setting | Where to change it |
| --- | --- |
| Model provider | Desktop **Settings → Server**, `openteam setup`, or `openteam model` (sign in first with `openteam provider login`) |
| Model and reasoning level | Desktop **Settings → Server**, or `openteam model` |
| Web search and page fetching | **Settings → Providers** on desktop or iPhone |
| Voice transcription | Desktop **Settings → Server**, or `openteam model` |
| Connection mode, API port, time zone, and tasks at once | `openteam setup --advanced` |
| Username and password | `openteam account update` |
| Accounts your bots use | **Marketplace** in the desktop app |

Model changes apply to new messages; a task that's already running keeps its settings. Search, fetch, and transcription changes apply to the next search, fetch, or voice note. Changes made with `openteam setup --advanced` restart the services they affect, which interrupts running tasks.

## Change setup options

Run this on the server host:

```sh
openteam setup --advanced
```

Advanced setup lets you change the [connection mode](remote-access.md), **API port** (default `8787`), time zone, tasks at once, model, and thinking level. Running setup again keeps your account and data.

**Time zone.** Setup uses the host's time zone. Routines you schedule in the app use the time zone of the device you schedule them on. Other routines use the server's time zone unless their schedule names one.

**Tasks at once.** This limits how many bot conversations the server works on at the same time, including helper tasks. Routine runs don't count toward it. The default is the number of CPU cores on the host, up to 8. Lower it if the host runs out of memory or your model provider rejects parallel requests. Each bot handles its chat messages one at a time; its routines can run alongside them.

## Configuration files

The [install directory](../getting-started/installation.md#where-openteam-is-installed) holds, among other files:

- `.env`: generated secrets and settings
- `compose.yaml`: the Docker services for your version
- `installation.json`: a record of how the server was installed

Setup and updates maintain these files, so change settings with the CLI instead of editing them. Don't put model API keys in `.env`; connect providers with `openteam setup` or in the app. Include this directory in your [backups](../manage/backups.md).

For less common options, such as running behind a proxy on another machine, see the [server configuration reference](../reference/server-configuration.md).
