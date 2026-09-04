# OpenTeam

**Self-hosted AI agents that keep working on your own hardware.**

OpenTeam gives AI agents a persistent Linux computer, shared files, and time to finish the job.
They keep working after you close the app. You can watch their screen or take over at any point.

```sh
curl -fsSL https://openteam.so/install | sh
```

[What you get](#what-you-get) · [How it works](#how-it-works) · [Quick start](#quick-start) ·
[Settings](#settings) · [Develop from source](#develop-from-source)

## What you get

- **Bots that remember.** One ongoing conversation per bot that resumes after restarts, plus dated
  Markdown memory in three scopes: per bot, shared across all bots, and per project. All
  hand-editable.
- **A real computer.** One always-on Debian XFCE desktop shared by every bot, with Chromium, a file
  manager, and a terminal. Each bot gets its own 1280×800 screen and browser profile, so logins
  persist and bots never fight over the mouse.
- **Watch or take over.** Live screen view in the desktop and iPhone apps over noVNC. A bot pauses
  and hands you the step when a login, 2FA, CAPTCHA, or payment needs a human, or asks you a
  yes/no question.
- **Shared workspace.** Every bot, room, routine, and subagent starts in `/workspace`. One bot's
  files are visible to the others immediately.
- **Routines.** A saved instruction on a schedule (cron, interval, or preset, up to 8 per routine).
  Runs in the bot's home conversation with full context and keeps a run history.
- **Teams.** Rooms of you plus up to six bots, replying in ordered rounds. Bots DM each other,
  create teammates, and launch subagents for parallel work: plain execution, computer use, browser
  use, or video review.
- **Skills and plugins.** Reusable `SKILL.md` files shared by every bot. MCP connectors from a
  built-in catalog (Gmail, Google Calendar, Google Drive, GitHub, Slack, Notion, Linear, Jira,
  Asana) or any custom MCP server, with per-bot access and per-tool allow/ask/deny policy.
- **Your model, your keys.** ChatGPT Plus/Pro or Claude Pro/Max sign-in, OpenAI or Anthropic API
  keys, or any OpenAI-, Anthropic-, or Google-compatible endpoint. Credentials live only in the
  runtime container. Neither the apps nor the bots can read them.
- **Native apps.** Electron desktop app for macOS, Windows, and Linux. iPhone app with push
  notifications.

## How it works

Everything runs in Docker Compose on one machine. The apps are thin clients: closing them never
stops a bot.

```text
 Desktop app · iPhone app        chat, live screens, settings (no model credentials)
          │  HTTPS + event stream
          ▼
       server ────────── PostgreSQL    bots, chat history, job queue
          │  durable "wake" job
          ▼
       worker                          one turn at a time per bot
          │  private token
          ▼
      computer                         Linux desktop + Pi agent runtime + model credentials
          ├── /workspace               shared files for every bot
          ├── one screen per bot       live view over noVNC
          └── provider credentials     readable by the runtime only, never by bots
```

1. The app posts your message to the **server**, which writes it to **PostgreSQL** and queues a
   durable wake job.
2. The **worker** claims the bot's turn. One turn per bot at a time; other wakes wait in its
   mailbox.
3. The **computer** reopens the bot's saved session and runs the model through
   [Pi](https://github.com/earendil-works/pi), the embedded agent runtime. Tools run in place:
   shell and files on the Linux box, mouse and keyboard on the bot's own screen, MCP plugins.
4. Events stream back through the worker into PostgreSQL, and the server pushes them to every
   connected app. iPhone gets a push notification when you are away.

Bots see eight built-in tools: `SendToUser`, `ReactToMessage`, `update_state`, `Shell`, `Read`,
`Screenshot`, `GetDynamicTools`, and `CallDynamicTool`. Everything else (the `Computer` tool,
messaging other bots, subagents, plugins) is discovered and called through the last two. On-disk
bot state and tool names use OpenTeam's portable layout, so bot files stay readable across hosts.

State lives in PostgreSQL plus five other Docker volumes: computer home (Pi sessions, credentials,
browser profiles), agent data, assets, workspace, and the snapshot store. A restart resumes
sessions, chat, memory, browser logins, schedules, and files. Back up and restore all six together;
`openteam update` dumps the database first and rolls back on failure. See
[backups and restore](docs/deployment.md#backups-and-restore).

## Quick start

Requirements: Docker with Compose 2.20+, an x64 or arm64 host, and 8 GB RAM and 8 GB free disk
recommended. The installer downloads a native CLI; Node.js and Bun are not required.

```sh
curl -fsSL https://openteam.so/install | sh      # macOS and Linux
irm https://openteam.so/install.ps1 | iex        # Windows PowerShell
```

The installer checks the host, verifies the signed release, pulls digest-pinned images, then asks
only for the choices it cannot safely make itself. It automatically uses a detected Tailscale,
WireGuard, or LAN address for private-network access, and reuses an existing Codex CLI or Claude
Code sign-in when available.

| Step | Choices |
| --- | --- |
| **Your account** | The username and password every app signs in with |
| **Inference** (optional) | ChatGPT Plus/Pro (default), Claude Pro/Max, an API key, another compatible provider, or skip for now. A recommended model is selected automatically. |

Run `openteam setup --advanced` to choose public HTTPS, an existing proxy, public HTTP, or
this-machine-only access instead.

Install the desktop app from [openteam.so/download](https://openteam.so/download), enter the
server URL, and sign in.

```sh
openteam status                        # health, version, access mode
openteam doctor                        # host, Docker, port, and readiness checks
openteam setup                         # change inference (--advanced: connection/server/model controls)
openteam update                        # update CLI + server with backup and rollback
openteam logs --service server --follow
```

The installer places `openteam` in `~/.local/bin` (Windows: `%LOCALAPPDATA%\OpenTeam\bin`, added
to your PATH); add the directory to `PATH` if your shell does not already include it. Full guide, including access modes, reverse proxies, updates, backups, and troubleshooting:
**[docs/deployment.md](docs/deployment.md)**.

## Settings

| Where | What | How to change |
| --- | --- | --- |
| Install `.env` (written by the CLI) | Access mode, public URL, port, time zone, worker concurrency, secrets | `openteam setup --advanced` for connection, port, time zone, reasoning, or concurrency |
| Server runtime settings | Provider, model, reasoning effort. Applies to new turns, no restart. | Desktop **Settings → Server**, or `openteam model use <provider> <model> --thinking <level>` |
| Per-bot files on the computer | Profile, memory, routines, skills, avatar | The apps, the bot itself via `update_state`, or edit the files by hand |

Every setting, file, and environment variable: **[docs/settings.md](docs/settings.md)**.

## Develop from source

Bun + Turborepo TypeScript monorepo. `apps/`: `server` (HTTP and event-stream API), `worker` (job
runner), `computer` (privileged runtime: Pi, desktop, tools, MCP), `desktop` (Electron), `mobile`
(Expo), `landing`, `cli`. `packages/`: `contracts`, `db` (Prisma), `messaging` (server domain
logic), `client-core`, `product-core`, `design-tokens`. Clients may import only `contracts`,
`client-core`, `product-core`, and `design-tokens`; `bun run check:architecture` enforces it.
`deploy/compose.yaml` ships in releases; the root `docker-compose.yml` is the dev stack.

```sh
cp .env.example .env    # set OPENTEAM_CONTROL_TOKEN, OPENTEAM_AUTH_SECRET, OPENTEAM_PROXY_SECRET (openssl rand -hex 32) and OPENTEAM_TIME_ZONE
bun install --frozen-lockfile
bash scripts/compose.sh up --build -d                                             # postgres, server, worker, computer
bash scripts/compose.sh ps                                                        # wait for healthy
bun run auth:setup                                                                # owner login (hidden prompt)
bash scripts/compose.sh exec computer openteam-pi-auth login openai-codex oauth   # provider sign-in
curl http://127.0.0.1:8787/api/v0/health                                          # "ready"
bun run desktop                                                                   # Electron against the local stack
```

The dev stack runs as Compose project `openteam-dev`, so its containers are `openteam-dev-*`, its
volumes `openteam-dev_openteam_*`, and every container carries the label
`com.openteam.environment=development` (released installs use `openteam` and `production`). It
reports its version as the package version plus `+dev`. It publishes the API on `127.0.0.1:8787`
and bot screens on `127.0.0.1:6200-6299`; the screen ports have no login of their own. Provider credentials go in the computer volume, never
`.env`. `bun run desktop:tailscale` serves the UI to other devices on your tailnet.

```sh
bun run check                             # typecheck + tests + build + performance budgets (what CI runs)
bun test                                  # unit tests
bun run check:architecture                # import boundaries, enum parity, mobile bundle contents
bun run db:generate                       # regenerate the Prisma client
bun run db:deploy                         # sync the schema and raw SQL objects
bun --filter @openteam/desktop package    # desktop installer
bash scripts/compose.sh logs -f server worker computer
sh scripts/backup.sh                      # dump Postgres and tar the volumes
```

Worker lifecycle integration test (needs a PostgreSQL database, uses a fake computer stream):

```sh
createdb openteam_test
DATABASE_URL=postgresql://localhost/openteam_test bun run db:deploy
OPENTEAM_TEST_DATABASE_URL=postgresql://localhost/openteam_test \
  bun test apps/worker/test/lifecycle.integration.test.ts
```

Releases are cut from `v*` tags. See [`.github/RELEASING.md`](.github/RELEASING.md).
