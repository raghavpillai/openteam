# Server settings

Guided setup covers most installations. This page shows where to change each setting afterward.

## Where to change what

| Setting | Where to change it |
| --- | --- |
| Model provider | **Settings → Model** on desktop or iPhone, or `openteam model` (sign in first with `openteam provider login`) |
| Model and reasoning level | **Settings → Model** on desktop or iPhone, or `openteam model` |
| Web search and page fetching | **Settings → Providers** on desktop or iPhone |
| Voice transcription | **Settings → Voice notes** on desktop or iPhone, or `openteam model` |
| Connection mode, including Tailscale HTTPS | `openteam setup` |
| Tailscale HTTPS enable, status, disable | `openteam tailscale` or desktop Settings → Server → Remote access |
| Time zone | **Settings → General → Timezone** on desktop, or **Settings → More preferences → Timezone** on iPhone |
| API port and tasks at once | `openteam setup --advanced` |
| Username and password | `openteam account update` |
| Accounts your bots use | **Marketplace** in the desktop app, or **Settings → Plugins** on iPhone |

Model changes apply to new messages; a task that's already running keeps its settings. Search, fetch, and transcription changes apply to the next search, fetch, or voice note. Changes made with `openteam setup --advanced` restart the services they affect, which interrupts running tasks.

## Time zone

Your time zone follows your device unless you pick one in **Settings → General → Timezone** on desktop or **Settings → More preferences → Timezone** on iPhone. The choice is saved on the server. Routines run in this time zone unless their schedule names another one, and your bots' computer sets its clock to it, so times and file dates there read in your local time.

## Change setup options

Run this on the server host:

```sh
openteam setup --advanced
```

Advanced setup lets you change the [connection mode](remote-access.md), **API port** (default `8787`), and tasks at once. Running setup again keeps your account, data, and model settings.

**Tasks at once.** This limits how many bot conversations the server works on at the same time, including helper tasks. Routine runs don't count toward it. The default is the number of CPU cores on the host, up to 8. Lower it if the host runs out of memory or your model provider rejects parallel requests. Each bot handles its chat messages one at a time; its routines can run alongside them.

## Configuration files

The [install directory](../getting-started/installation.md#where-openteam-is-installed) holds, among other files:

- `.env`: generated secrets and settings
- `compose.yaml`: the Docker services for your version
- `installation.json`: a record of how the server was installed

Setup and updates maintain these files, so use the apps or the CLI for every setting they cover. A few settings have no command and go in `.env`: [log rotation](../manage/updates.md#disk-use-after-updates), [update backup retention](../manage/backups.md#update-backups), and [desktop memory limits](#desktop-memory-limits). Setup and updates keep the lines you add.

Backup retention is read at the next update. For the other settings, run `openteam stop` and then `openteam start`, which recreates the containers whose settings changed and interrupts running tasks. `openteam start` alone does nothing while the server is running. The next update also applies them.

Don't put model API keys in `.env`; connect providers in the app or with `openteam provider login`. Include this directory in your [backups](../manage/backups.md).

## Existing Messages SSH connections

If you have an **iMessage (SSH)** connection, it keeps working across updates. Its bridge address and token are saved in `/home/box/.config/openteam/imessage-bridge.json` on the bots' computer, in `endpoint` and `token` fields. Keep the file readable only by its owner (`0600`) and treat the token like a password. The endpoint must be an `http://` or `https://` URL with a numeric IP address; hostnames don't work. If the host bridge was down when the connection started, reconnect the account on the plugin's page once the bridge is back.

## Desktop memory limits

Each bot desktop can use up to **10 GiB** of memory by default, including its browser, apps, and the commands it runs. The whole computer has a combined ceiling: the smaller of **12 GiB** and **75% of the host's RAM** (the Docker VM's RAM on macOS). A desktop also can't use more than what's left of the combined ceiling. These are ceilings, not reservations, and the computer doesn't use swap.

When a desktop hits its limit, Linux may kill one of its processes, and unsaved work in that process is lost. Hitting the combined ceiling may restart the computer.

To change the limits, set these in the install directory's `.env`:

- `OPENTEAM_DESKTOP_MEMORY_LIMIT` (default `10g`): each desktop.
- `OPENTEAM_COMPUTER_MEMORY_LIMIT` (default `12g`): the whole computer, still capped at 75% of RAM. Use a smaller value to leave more room for other services.

Sizes use binary units: `10g` is 10 × 1024³ bytes. Apply a change with `openteam stop` and then `openteam start`; this recreates the computer and interrupts running work.

The limits need Linux [cgroup v2](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html); if they can't be set up, the computer doesn't start. Administrator (`sudo`) commands on the bots' computer can change or bypass them, so treat them as default budgets, not a security boundary.
