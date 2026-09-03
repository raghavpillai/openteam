# OpenTeam

**Self-hosted AI agents that keep working on your own hardware.**

OpenTeam gives AI agents a persistent Linux computer, shared files, and enough time to finish the
job. Agents keep working after you close the app. You can watch their screen, or take over, at any
point.

```sh
bunx --bun @openteam/cli install
```

- [What you get](#what-you-get)
- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Settings](#settings)
- [Concepts](#concepts)
- [Repo layout](#repo-layout)
- [Develop from source](#develop-from-source)
- [Checks and tests](#checks-and-tests)
- [Data and backups](#data-and-backups)
- [Project status](#project-status)

## What you get

- **Bots that remember.** Each bot has one ongoing conversation that picks up where it left off,
  even after a restart. Bots also keep plain Markdown memory files you can read and edit.
- **A real computer.** All bots share one always-on Linux desktop with a Chromium browser, a file
  manager, and a terminal. Each bot gets its own screen, so they never fight over the mouse.
- **Watch or take over.** Open a bot's live screen from the desktop or iPhone app. Take control
  when a sign-in, approval, or judgment call needs you. Browser logins persist between sessions.
- **Shared workspace.** Every bot works in the same `/workspace` folder. Finished work lands there,
  and one bot's files are visible to the others right away.
- **Routines.** Give a bot a job and a schedule. It wakes up with its full context, does the job,
  and keeps a run history.
- **Teams.** Put up to six bots in a room. Bots can message each other, create teammates, and
  spin up temporary subagents for parallel work.
- **Plugins.** Connect outside tools over MCP. The built-in catalog covers Gmail, Google Calendar,
  Google Drive, GitHub, Slack, Notion, Linear, Jira, and Asana, with per-bot access control.
- **Your model, your keys.** Sign in with ChatGPT Plus/Pro or Claude Pro/Max, or use an OpenAI or
  Anthropic API key, or any compatible custom endpoint. Credentials stay on the server. The apps
  and the bots themselves never see them.
- **Native apps.** A desktop app for macOS, Windows, and Linux, plus an iPhone app with push
  notifications.

## How it works

The whole stack runs in Docker Compose on one machine. The apps are thin clients: closing them
never stops a bot.

```text
 Desktop app · iPhone app        chat, live screens, settings (no model credentials)
          │  HTTPS + event stream
          ▼
       server ────────── PostgreSQL    bots, chat history, job queue
          │  durable "wake" job
          ▼
       worker                          runs one turn at a time per bot
          │  private token
          ▼
      computer                         Linux desktop + Pi agent runtime + model credentials
          ├── /workspace               shared files for every bot
          ├── one screen per bot       live view over noVNC
          └── provider credentials     readable only by the runtime, not by bots
```

What happens when you send a message:

1. The app posts it to the **server**, which stores it in **PostgreSQL** and queues a "wake" job.
2. The **worker** picks up the job and claims that bot's turn. A bot runs one turn at a time.
3. The worker asks the **computer** service to run the turn. The computer reopens the bot's saved
   session and calls the model through [Pi](https://github.com/earendil-works/pi), the embedded
   agent runtime.
4. Tools run right there: shell and file access on the Linux box, mouse and keyboard on the bot's
   own screen, and MCP plugins.
5. Every event streams back through the worker into PostgreSQL, and the server pushes it to all
   connected apps. iPhone gets a push notification if you are away.

Because state lives in PostgreSQL and Docker volumes, a restart resumes the bot's session,
chat history, memory, browser logins, schedules, and files instead of starting from a blank
conversation.

## Quick start

You need Docker with Compose 2.20 or newer, plus Node 20.17+ or Bun. An x64 or arm64 host with
8 GB of RAM and 8 GB of free disk is recommended.

```sh
bunx --bun @openteam/cli install     # or: npx @openteam/cli install
```

The installer checks the host, downloads and verifies the signed release, pulls the images, then
walks you through:

1. **Access.** How to reach the server: public HTTPS with automatic certificates (default), an
   existing reverse proxy, public HTTP, private network, or this machine only.
2. **Owner account.** The single username and password used by every app.
3. **Model provider.** Sign in with ChatGPT Plus/Pro (default), Claude Pro/Max, an API key, or a
   custom endpoint, and pick a model.

Then install the desktop app from the
[GitHub releases](https://github.com/raghavpillai/openteam/releases), point it at your server URL,
and sign in.

Useful commands afterwards:

```sh
bunx --bun @openteam/cli status      # is it healthy?
bunx --bun @openteam/cli doctor      # diagnose problems
bunx --bun @openteam/cli setup       # change access or runtime settings
bunx --bun @openteam/cli update      # upgrade with backup and rollback
```

Full details, including access modes, reverse proxies, updates, backups, and troubleshooting, are
in **[docs/deployment.md](docs/deployment.md)**.

## Settings

Settings live in three places:

| Where | What | How to change it |
| --- | --- | --- |
| Install `.env` (written by the CLI) | Ports, access mode, public URL, time zone, worker concurrency, secrets | `openteam setup` (add `--advanced` for port, time zone, reasoning, concurrency) |
| Server runtime settings | Active provider, model, and reasoning effort. Applies to new turns without a restart. | Desktop **Settings → Server**, or `openteam model use <provider> <model>` |
| Per-bot files on the computer | Profile, memory, routines, skills, avatar | The apps, the bot itself through `update_state`, or edit the files by hand |

The full list of settings, files, and environment variables is in
**[docs/settings.md](docs/settings.md)**.

## Concepts

| Concept | In short |
| --- | --- |
| **Bot** | A named agent with its own persona, memory, and screen. It has one home conversation that resumes across restarts. |
| **Direct message** | Your private chat with one bot. Bots can also DM each other, and you can read those. |
| **Group** | A room with you and up to six bots. Bots reply in an ordered round so the thread stays readable. |
| **Routine** | A saved instruction on a schedule. Runs in the bot's home conversation and keeps a run history. |
| **Subagent** | A temporary helper a bot launches for parallel work. Variants exist for plain execution, computer use, browser use, and video review. |
| **Computer** | The shared Debian XFCE desktop. Every bot gets its own 1280×800 display, browser profile, and terminal. |
| **Workspace** | The shared `/workspace` folder every bot, room, routine, and subagent starts in. |
| **Memory** | Dated Markdown facts in three scopes: per bot, shared across all bots, and per project. Hand-editable. |
| **Skill** | A reusable `SKILL.md` instruction file. Skills are global to the computer, so every bot can use them. |
| **Plugin** | An MCP connector from the built-in catalog. Remote HTTP plugins run in the server; local ones run on the computer. |
| **Project** | A named shared folder with its own notes and memory that bots can join. |
| **Approval** | A bot can pause and hand a step to you, such as a login, 2FA, CAPTCHA, or payment, or ask you a yes/no question. |

Bots see a small set of built-in tools: `SendToUser`, `ReactToMessage`, `update_state`, `Shell`,
`Read`, `Screenshot`, `GetDynamicTools`, and `CallDynamicTool`. Everything else, including the
`Computer` tool, messaging other bots, subagents, and plugins, is discovered and called through the
last two. The on-disk bot state and tool names follow the layout used by xAI's Grok Bot, so bot
files stay readable and portable.

## Repo layout

This is a Bun + Turborepo monorepo written in TypeScript.

| Path | Job |
| --- | --- |
| `apps/server` | HTTP and event-stream API. Auth, bots, channels, messages, routines, plugins, settings. |
| `apps/worker` | Job runner. Claims bot turns, drives them against the computer, writes results to PostgreSQL, dispatches routines, sends push notifications. |
| `apps/computer` | The privileged runtime container. Embeds Pi, owns model credentials, runs the Linux desktop, screens, tools, MCP servers, and browser control. |
| `apps/desktop` | Electron client for macOS, Windows, and Linux. |
| `apps/mobile` | Expo / React Native iPhone client. |
| `apps/landing` | Marketing site. |
| `apps/cli` | `@openteam/cli`: installs, configures, updates, and diagnoses the self-hosted stack. |
| `packages/contracts` | Shared API, event, and settings types, plus the tool catalogs. |
| `packages/db` | Prisma schema, migrations, and generated client. |
| `packages/messaging` | Server-side domain logic: agent files, memory, skills, routines, group routing, assets. |
| `packages/client-core` | Platform-neutral HTTP and event-stream client. Transport only. |
| `packages/product-core` | Pure client-side logic shared by desktop and iPhone: snapshot indexing, threads, search. |
| `packages/design-tokens` | Theme values and avatar artwork shared by both apps. |
| `deploy/compose.yaml` | The Compose file shipped in releases. `docker-compose.yml` at the root is the dev version. |
| `docker/` | Dockerfiles for the app images and the computer image. |

Dependency direction is enforced: clients import from `contracts`, `client-core`, `product-core`,
and `design-tokens` only, never from `db`, `messaging`, or the server apps.
`bun run check:architecture` checks this.

## Develop from source

You need Docker with Compose and [Bun](https://bun.com/).

```sh
cp .env.example .env
```

Edit `.env`: replace `OPENTEAM_CONTROL_TOKEN`, `OPENTEAM_AUTH_SECRET`, and `OPENTEAM_PROXY_SECRET`
with different random values (`openssl rand -hex 32`), and set `OPENTEAM_TIME_ZONE` to your IANA
zone, such as `America/New_York`.

```sh
bun install --frozen-lockfile
bash scripts/compose.sh up --build -d        # build and start postgres, server, worker, computer
bash scripts/compose.sh ps                   # wait until everything is healthy
bun run auth:setup                           # create the owner login (password is hidden)
bash scripts/compose.sh exec computer openteam-pi-auth login openai-codex oauth   # sign in a provider
curl http://127.0.0.1:8787/api/v0/health     # should report "ready"
bun run desktop                              # start the Electron app against the local stack
```

The dev stack publishes the API on `127.0.0.1:8787` and bot screens on `127.0.0.1:6200-6299`.
Never put provider credentials in `.env`; the provider login command stores them inside the
computer container's private volume.

To try the UI from another device on your Tailscale network, run `bun run desktop:tailscale` and
open the printed URL. Stop it when you are done, since the screen viewer ports have no login of
their own.

Other useful scripts:

```sh
bun run check                                # typecheck + tests + build + performance budgets
bun run db:generate                          # regenerate the Prisma client
bun --filter @openteam/desktop package        # build a desktop installer
bash scripts/compose.sh logs -f server worker computer
bash scripts/compose.sh down
```

## Checks and tests

```sh
bun test                    # unit tests
bun run check:architecture  # import boundaries, enum parity, mobile bundle contents
bun run check               # everything, as CI runs it
```

The worker lifecycle integration test needs a PostgreSQL database and uses a fake computer stream:

```sh
createdb openteam_test
DATABASE_URL=postgresql://localhost/openteam_test bun run db:deploy
OPENTEAM_TEST_DATABASE_URL=postgresql://localhost/openteam_test \
  bun test apps/worker/test/lifecycle.integration.test.ts
```

## Data and backups

Everything OpenTeam needs to recover lives in PostgreSQL plus a handful of Docker volumes: the
computer's home (Pi sessions, provider credentials, browser profiles), the editable agent data,
uploaded assets, the shared workspace, and the snapshot store. They form one recovery set, so back
up and restore them together.

`openteam update` takes a database backup before every upgrade and rolls back on failure. For a
full manual backup of the dev stack, run `sh scripts/backup.sh`. See
[docs/deployment.md](docs/deployment.md#backups-and-restore) for the details.

## Project status

OpenTeam is a v0 for people comfortable running Docker. Shipped areas are stable enough to use
daily. Remaining work: hardening remote
computer access for public deployments, plugin updates and a real local sandbox, non-cron routine
triggers, and finishing iPhone release signing.

Releases are cut from tags; the process is in [`.github/RELEASING.md`](.github/RELEASING.md).

## References

- [Pi agent runtime](https://github.com/earendil-works/pi) and its
  [SDK guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md),
  [session format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sessions.md),
  and [compaction](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md)
- [OpenAI Codex authentication](https://learn.chatgpt.com/docs/auth)
- Desktop design system: `apps/desktop/DESIGN.md`
