# OpenTeam settings

Every setting a user can change, and where it lives.

Settings sit in three layers. Start with the table below, then read the section for the layer you
need.

| I want to change | Layer | Where |
| --- | --- | --- |
| How the server is reached, its port, time zone, or concurrency | [Installation](#1-installation-settings) | `openteam setup` writes `.env` |
| Which model provider, model, or reasoning effort bots use | [Model](#2-model-settings) | Desktop **Settings → Server**, or `openteam model use` |
| A bot's name, avatar, description, or notifications | [Bot](#3-bot-settings) | The apps, or the bot's own files |
| A routine's schedule | [Routines](#4-routines) | Routine editor in the apps |
| Which plugins a bot may use, and tool policy | [Plugins](#5-plugins) | Desktop **Plugins** dialog |
| Theme, server URL, auto-review, local execution | [App settings](#6-app-settings) | Each app, stored on that device |
| Experimental flags | [Advanced](#7-advanced-and-experimental) | `.env` by hand |

- [1. Installation settings](#1-installation-settings)
- [2. Model settings](#2-model-settings)
- [3. Bot settings](#3-bot-settings)
- [4. Routines](#4-routines)
- [5. Plugins](#5-plugins)
- [6. App settings](#6-app-settings)
- [7. Advanced and experimental](#7-advanced-and-experimental)
- [Environment variable reference](#environment-variable-reference)

## 1. Installation settings

These live in `<install dir>/.env` (default `~/.openteam/.env`) and are read when containers
start. The CLI writes this file. Change values with:

```sh
openteam setup              # access mode, owner account, provider and model
openteam setup --advanced   # also API port, time zone, reasoning effort, concurrent bot turns
```

Setup restarts the stack for you and rolls the file back if the new values fail to start.

| Setting | Values | Default | Meaning |
| --- | --- | --- | --- |
| `OPENTEAM_ACCESS_MODE` | `https`, `proxy`, `http`, `private`, `local` | `https` on a fresh install | How clients reach the server. See [deployment](deployment.md#choose-how-to-reach-it). |
| `OPENTEAM_PUBLIC_URL` | URL | `http://127.0.0.1:8787` | The address the apps use. Also the HTTPS domain Caddy serves. |
| `OPENTEAM_API_PORT` | 1 to 65535 | `8787` | Host port for the API. |
| `OPENTEAM_TIME_ZONE` | IANA zone | Detected at install, else `UTC` | Time zone for routine schedules and timestamps. |
| `OPENTEAM_WORKER_CONCURRENCY` | 1 to 64 | `8` | How many bot turns can run at the same time across all bots. Each bot still runs one turn at a time. |
| `OPENTEAM_AUTH_MODE` | `required`, `disabled` | `required` | `disabled` removes API login entirely. Trusted, isolated networks only. |
| `COMPOSE_PROFILES` | `https`, `direct` | Set by access mode | `https` adds the Caddy container. |
| `OPENTEAM_BIND_HOST`, `OPENTEAM_VIEWER_BIND_HOST`, `OPENTEAM_PUBLIC_HOST`, `OPENTEAM_AUTH_URL` | Hosts and URLs | Set by access mode | Derived from the access mode. Do not edit by hand. |

The file also holds four generated secrets (`OPENTEAM_POSTGRES_PASSWORD`, `OPENTEAM_CONTROL_TOKEN`,
`OPENTEAM_AUTH_SECRET`, `OPENTEAM_PROXY_SECRET`), the release version, and the image registry
prefix. Leave those alone. The owner password and provider credentials are never stored here.

## 2. Model settings

Three values apply to every bot: the **provider**, the **model**, and the **reasoning effort**.
They are runtime settings, not environment variables. Changes apply to the next turn of every bot
and to background inference without a restart. A turn that is already running keeps the values it
started with.

Change them from:

- Desktop app: **Settings → Server**. Pick a provider, connect it, choose a model and reasoning
  level, then **Apply**.
- CLI: `openteam model use <provider> <model> [--thinking <level>]`.
- During `openteam setup`.

| Setting | Values | Default |
| --- | --- | --- |
| Provider | `openai-codex`, `anthropic`, `openai`, or a custom provider id | `openai-codex` |
| Model | Any model the provider lists (`openteam model list <provider>`) | `gpt-5.5` |
| Reasoning effort | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | `high` |

Reasoning is forced to `off` for models that do not support it. The selection is verified against
the provider before it is saved.

**Where it is stored.** The file `settings.json` at the root of the agent-data volume
(`/home/box/agent-data/settings.json` inside the containers). Only the `inference` block matters
here:

```json
{
  "version": 1,
  "inference": { "providerId": "anthropic", "modelId": "claude-sonnet-5", "reasoning": "high" }
}
```

The file is written atomically by the server. Other fields in it exist for file-format
compatibility and are not used by OpenTeam's apps today.

**Connecting a provider.** Sign in from the desktop Server page (choose `oauth` or `api_key`,
then follow the prompt) or with `openteam provider login <provider> --auth <oauth|api-key>`.
Credentials are stored in the computer container under `/home/box/.pi/agent/auth.json`, owned by
the runtime user. Bots cannot read that file, and the apps never receive credential values.

**Custom providers.** Add any compatible endpoint with `openteam provider add`, choosing the
adapter `openai-completions`, `openai-responses`, `anthropic-messages`, or
`google-generative-ai`. See [deployment](deployment.md#connect-a-model-provider) for the full
command.

## 3. Bot settings

**In the apps.** On desktop, open a bot and switch the inspector to settings. On iPhone, bot-level
switches are under **Settings → Advanced**.

| Setting | Limit | Where in the UI |
| --- | --- | --- |
| Name | 80 characters, blank becomes "New Bot" | Desktop inspector |
| Label (optional title, such as "Research") | 120 characters | Desktop inspector |
| Description | 2,000 characters | Desktop inspector |
| Avatar icon and color, or an uploaded image up to 5 MB | | Desktop inspector |
| Notifications for this bot | on or off | Desktop inspector, iPhone bot alerts |
| Hidden from sidebar | on or off | Desktop bot menu, iPhone hidden conversations |
| Instructions | 20,000 characters | API only; no app control yet |

There is no per-bot model, reasoning, or tool list. All bots share the model settings above.
Bots can also change their own name, description, and avatar through their `update_state` tool.

**On disk.** Every bot has a folder under the agent-data volume at
`agents/<bot-id>/` (`/home/box/sand-data/agents/<bot-id>` in the computer container). You can read
and edit these files by hand. OpenTeam reads them before building the bot's next prompt.

| File | What it holds |
| --- | --- |
| `profile.json` | `name`, `description`, `title`, `avatarShape`, `avatarColor`. Regenerated if missing or invalid. |
| `settings.json` | `notifyOnAgentUpdates` (default `true`) and `hiddenFromSidebar` (default `false`). Unknown keys are kept. |
| `avatar.<png\|jpg\|jpeg\|webp\|gif\|svg>` | The uploaded avatar image. |
| `memory/` | Dated Markdown facts. Deleting a line forgets that fact. |
| `<routine>/automation.json` | One folder per routine. Deleting the folder removes the routine. |
| `projects.json` | Projects the bot has joined. |
| `store.db`, `conversation-blobs.db` | Transcript rows and message envelopes. Do not edit. |

Shared files next to the bot folders: `workflows/<slug>/SKILL.md` for skills (global to every
bot), `user-memory/` for memory shared across bots, and `projects/` for per-project memory. Skills
and routines with invalid content are kept and reported rather than overwritten.

## 4. Routines

A routine is a saved instruction with a schedule. Edit routines in the routine panel on desktop or
the routine editor on iPhone. A bot can also create and edit its own routines through
`update_state`.

| Setting | Details |
| --- | --- |
| Schedule kind | Fixed presets, a cron expression, or an interval. Up to 8 schedules per routine. Event-based triggers are not available yet. |
| Interval | Minimum 5 minutes when `OPENTEAM_ENFORCE_AUTOMATION_MINIMUM=true` is set; otherwise not enforced. |
| Time zone | Each routine stores the time zone the app detected when you saved it. The installation zone (`OPENTEAM_TIME_ZONE`) is the fallback. |
| Enabled | Pause a routine without deleting it. |

Schedules are checked at least once a minute. Each run wakes the bot in its normal home conversation and
is recorded in the routine's run history.

## 5. Plugins

Plugins are MCP connectors. Open the **Plugins** dialog on desktop, or the plugin sheet on iPhone,
to browse the built-in catalog, install a plugin, and connect an account.

| Setting | Values | Notes |
| --- | --- | --- |
| Authentication | `none`, `token` (token or headers), `oauth` | Chosen per connection. |
| Bot access | Per bot: enabled or not, optionally with the plugin's skills | Desktop only. |
| Tool policy | Per tool, per bot or global: `allow`, `prompt` (ask first), `deny` | Desktop only. |
| Custom MCP server | Name, URL or command with args, env, headers, auth type | Add from the Plugins dialog. |
| Instructions | Up to 500 characters of extra guidance per plugin | |

Remote HTTP plugins run inside the server. Local command-based plugins run on the shared computer.
Installing a plugin snapshots its definition, so later catalog changes do not alter an existing
install.

**Replacing the catalog.** Set `OPENTEAM_MARKETPLACE_FILE` in `.env` to an absolute path, mounted
into the server container, of a JSON manifest in the shape defined by
`apps/server/src/plugins/openteam-marketplace.ts`. Restart the server afterwards. The bundled
catalog is in `apps/server/src/plugins/catalog.ts`.

## 6. App settings

These are stored on the device and are not synced to the server unless noted.

**Desktop** (**Settings** dialog):

| Page | Setting | Notes |
| --- | --- | --- |
| General | Theme: system, light, dark | Device-local |
| General | Sign out | |
| General | Auto-review on or off, plus up to 20 "allow" and 20 "ask first" rules of 1,000 characters each | Rules that decide which local actions run automatically |
| Computer | Label for this computer | Shown to bots that use the local host bridge |
| Computer | Execution on this computer: ask every time, always allow, never allow | Default is ask |
| Server | Provider, connection, model, reasoning | Server-owned. See [Model settings](#2-model-settings). |
| Updates | Desktop app update, server update, SSH destination for a remote server | The SSH destination is stored per server URL on this device |

The server URL is set on the sign-in screen and remembered on the device. Sidebar layout (pinned
bots, custom sections) is stored locally and also synced to the server so it follows you between
desktops. Keyboard shortcuts are fixed: `⌘K` / `Ctrl+K` opens search.

**iPhone** (**Settings**):

| Setting | Values | Notes |
| --- | --- | --- |
| Server endpoint | URL | Under Advanced. Must be HTTPS or a private address. |
| Appearance | Mode: system, day, night. Accent: black or blue. | |
| Notifications | iOS permission | Push notifications arrive through Expo |
| Bot alerts | Per bot on or off | Same setting as desktop bot notifications |
| Hidden conversations | Show | Un-hides a bot |

Auto-review, time zone, language, and haptics are shown for information but are managed by the
desktop app or the device.

## 7. Advanced and experimental

Set these by editing `.env` in the install directory, then restart with `openteam stop` and
`openteam start`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENTEAM_MEMORY_DREAMING` | `false` | Turns on background memory synthesis across bots. Experimental, installation-wide, not per bot. |
| `OPENTEAM_MARKETPLACE_FILE` | empty | Path to a custom plugin catalog. See [Plugins](#5-plugins). |
| `OPENTEAM_ENFORCE_AUTOMATION_MINIMUM` | unset | `true` enforces the 5-minute minimum routine interval. |
| `EXPO_ACCESS_TOKEN` | empty | Optional token for the Expo push service, for enhanced push security. |
| `OPENTEAM_BOX_COPY_IN` | `0` | `1` copies the snapshot store into the computer on boot. |

There is no setting for the number of subagents a bot may run. `OPENTEAM_SUBAGENT_PER_PARENT_LIMIT`
and `OPENTEAM_SUBAGENT_GLOBAL_LIMIT` appear in `.env.example` but nothing reads them today.

## Environment variable reference

Everything the containers read, for operators who want the full picture. "Set by" says who
normally writes it; "Restart" says whether a change needs a container restart.

| Variable | Default | Set by | Restart | Meaning |
| --- | --- | --- | --- | --- |
| `OPENTEAM_VERSION` | release | install, update | yes | Release version and image tag |
| `OPENTEAM_IMAGE_PREFIX` | `ghcr.io/raghavpillai/openteam` | install | yes | Image registry prefix |
| `OPENTEAM_POSTGRES_PASSWORD` | generated | install | yes | Database password |
| `OPENTEAM_CONTROL_TOKEN` | generated | install | yes | Token the server, worker, computer, and CLI use with each other |
| `OPENTEAM_AUTH_SECRET` | generated | install | yes | Signs login sessions |
| `OPENTEAM_PROXY_SECRET` | generated | install | yes | Shared secret a reverse proxy can send in `X-OpenTeam-Proxy` |
| `OPENTEAM_AUTH_MODE` | `required` | setup | yes | `required` or `disabled` |
| `OPENTEAM_ACCESS_MODE` | `local` | setup | yes | `https`, `proxy`, `http`, `private`, `local` |
| `OPENTEAM_PUBLIC_URL` | `http://127.0.0.1:8787` | setup | yes | Client-facing base URL, plugin OAuth redirects, Caddy domain |
| `OPENTEAM_AUTH_URL` | same as public URL | setup | yes | Base URL for the auth library |
| `OPENTEAM_API_PORT` | `8787` | setup | yes | Host port for the API |
| `OPENTEAM_BIND_HOST` | `127.0.0.1` | setup | yes | Interface the API port binds to |
| `OPENTEAM_VIEWER_BIND_HOST` | `127.0.0.1` | setup | yes | Interface for screen viewer ports `6200-6299` |
| `OPENTEAM_PUBLIC_HOST` | `127.0.0.1` | setup | yes | Host the apps use to open screen viewers |
| `COMPOSE_PROFILES` | `direct` | setup | yes | `https` enables Caddy |
| `OPENTEAM_TIME_ZONE` | `UTC` | setup | yes | Installation time zone |
| `OPENTEAM_WORKER_CONCURRENCY` | `8` | setup `--advanced` | yes | Concurrent bot turns |
| `OPENTEAM_MEMORY_DREAMING` | `false` | by hand | yes | Memory synthesis experiment |
| `OPENTEAM_MARKETPLACE_FILE` | empty | by hand | yes | Custom plugin catalog path |
| `OPENTEAM_ENFORCE_AUTOMATION_MINIMUM` | unset | by hand | yes | Enforce 5-minute routine minimum |
| `EXPO_ACCESS_TOKEN` | empty | by hand | yes | Expo push token |
| `OPENTEAM_BOX_COPY_IN` | `0` | by hand | yes | Copy snapshot store in on boot |
| `OPENTEAM_MCP_OAUTH_CLIENT_ID`, `OPENTEAM_MCP_OAUTH_CLIENT_SECRET` | unset | by hand | yes | Fallback OAuth client for MCP plugins |

Fixed inside the Compose file, not meant to change: `DATABASE_URL`, `OPENTEAM_PORT` (`8787`),
`OPENTEAM_COMPUTER_URL`, `OPENTEAM_COMPUTER_PORT` (`8790`), `OPENTEAM_SERVER_URL`,
`OPENTEAM_WORKSPACE_ROOT` (`/workspace`), `OPENTEAM_AGENT_DATA_ROOT` (`/home/box/agent-data`),
`OPENTEAM_AGENT_DATA_CANONICAL_ROOT` (`/home/box/sand-data`), `OPENTEAM_ASSET_ROOT`
(`/asset-store`), `OPENTEAM_BOX_STORE_ROOT` (`/box-store`), `OPENTEAM_PI_AGENT_DIR`
(`/home/box/.pi/agent`), `OPENTEAM_SCREEN_VIEWER_HOST`, and the agent user ids
`OPENTEAM_AGENT_UID` (`1001`) and `OPENTEAM_AGENT_GID` (`1000`).

Development-only variables for the desktop app: `OPENTEAM_SERVER_URL`, `OPENTEAM_RENDERER_URL`,
`OPENTEAM_HOST_BRIDGE_PORT` (`8791`), `OPENTEAM_AUTO_REVIEW_MODE` (`off`, `shadow`, `enforce`),
`OPENTEAM_UPDATE_MANIFEST_URL`, `OPENTEAM_DEV_HOST`, and `VITE_OPENTEAM_API_URL`.
