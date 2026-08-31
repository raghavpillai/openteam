# OpenBot v0

OpenBot is a self-hosted, desktop-first home for durable Pi agents backed by OpenAI Codex. Each Bot owns one home Pi context, one Postgres inbox, Grok-compatible file state, and a persistent graphical Linux screen. Direct, peer, room, routine, bootstrap, and subagent-completion wakes all resume the member Bot's home context.

Every Bot works as `box` (uid/gid 1000) on the same persistent Linux computer and starts in `/workspace`, so files written by one are immediately visible to the others. Bots get independent 1280×800 XFCE displays with Google Chrome, Thunar, XFCE Terminal, screenshots, structured mouse/keyboard actions, and live noVNC takeover. Chrome profiles and sign-ins are computer-scoped and persist under `/home/box/chrome-profile[-N]`.

## What is implemented

- Bun 1.3.8 + Turborepo TypeScript monorepo
- Effect-based application and service boundaries
- Prisma 7.9.1, PostgreSQL, and pg-boss 12.28.0 durable mailboxes
- Pi `@earendil-works/pi-coding-agent` 0.84.3 embedded through its TypeScript SDK
- one append-only Pi session tree per bot context, reopened after worker, gateway, and Compose restarts
- OpenAI Codex OAuth through Pi's `openai-codex` provider
- Grok-compatible automatic context self-summary with per-context durable archives, restart reconstruction, and no manual Compact surface
- the Grok Bot model surface: `SendToUser`, `ReactToMessage`, `update_state`, `Shell`, `Read`, `Screenshot`, `GetDynamicTools`, and `CallDynamicTool`; the physical-host bridge is not model-exposed
- OpenBot-only dynamic discovery and dispatch; `openbot` exposes `Computer`, while `cursor` exposes `SendToAgent` plus the approved todo/orchestration/administration tools: `TodoWrite`, `Task`, `CheckSubagent`, `MessageSubagent`, `StopSubagent`, `CreateAgent`, `UpdateAgent`, `CreateChannel`, and `UpdateChannel`
- durable parent-owned subagent attempts backed by hidden runtime actors, image forwarding and bounded video-frame extraction, live status/transcripts, steering, cancellation, resume, and private completion wakes; `computerUse` gets direct screenshot/pixel control while `browserUse` gets a direct 15-tool Playwright/CDP page-control surface
- typed, audited agent/channel administration plus durable per-agent todo queues
- durable scheduled routines created and managed through `update_state`, with a once-per-minute pg-boss dispatcher and execution history
- durable direct-agent channels and restart-safe ordered group rounds
- one shared Debian XFCE computer with bot-specific displays, browser profiles, and input leases
- one persistent, shared, writable `/workspace` for every Bot, room, routine, A2A wake, and subagent
- Electron 43, React 19, Tailwind 4, shadcn/ui, and source-owned AI Elements adaptations
- one Better Auth owner account with username/password login for desktop and iOS
- snapshot + replayable SSE client state, streamed messages and activity, stop, bot CRUD, runtime health, and an interactive desktop viewer

## Architecture

```text
Electron (lightweight native client; no model credentials)
        ▼
server ───── PostgreSQL + pg-boss
                  │ durable wake
                  ▼
               worker ── one active turn lease per Bot
                  │ private token + NDJSON
                  ▼
computer gateway ── embedded Pi AgentSession
        │                 └── openai-codex OAuth provider
        ├── /home/box/.pi/agent
        │     ├── auth.json
        │     ├── sessions/openbot/<context-session>.jsonl
        │     └── context-sessions/<context-session>/manifest.json + blobs/
        ├── /home/box/sand-data
        │     ├── agents/<bot-or-room>/{profile.json,settings.json,store.db,...}
        │     ├── workflows/<slug>/SKILL.md
        │     └── user-memory + projects
        ├── /home/box/agent-data -> /home/box/sand-data
        ├── /workspace (shared working directory)
        ├── /box-store (content-addressed snapshot replica)
        └── ScreenBroker
              ├── Bot A display :100 → noVNC :6200
              ├── Bot B display :101 → noVNC :6201
              └── computer-scoped Chrome profiles
```

Postgres remains a product projection for mailboxes, visible chat, group delivery, run audit, and client replay. Grok-compatible `store.db` and `conversation-blobs.db` files retain per-Bot prompt snapshots, transcript rows, and content-addressed message envelopes; Pi's JSONL/context archive retains runtime continuation and adopted summary reconstruction. All wake types resume the Bot's home context from `/workspace`.

## Install the released server stack

Docker with Compose is the only system prerequisite. Install the versioned server, worker,
PostgreSQL database, migrations, and shared graphical computer with Bun:

```sh
bunx --bun @openbot/cli install
```

The same CLI can run through Node/npm:

```sh
npx @openbot/cli install
```

The installer verifies Docker and the host, generates private installation secrets, verifies the
release bundle checksum, pulls prebuilt `linux/amd64` or `linux/arm64` images, starts the Compose
project in the background, and waits for OpenBot health. The API and screen viewers remain bound to
loopback. Run diagnostics and manage the installation with:

```sh
bunx --bun @openbot/cli doctor
bunx --bun @openbot/cli setup
bunx --bun @openbot/cli status
bunx --bun @openbot/cli stop
bunx --bun @openbot/cli start
bunx --bun @openbot/cli account update
bunx --bun @openbot/cli password reset
bunx --bun @openbot/cli update
bunx --bun @openbot/cli uninstall
```

After installation, `openbot setup` asks whether the server should be local or available on a
private network, creates the single OpenBot username/password account, then offers to start OpenAI
Codex sign-in. Password input is hidden, is never written to the installation `.env`, and is hashed
by Better Auth in Postgres. `openbot account update` interactively changes both credentials;
`--username <name>` changes only the username, `--password` securely prompts for only a new
password, and the flags can be combined. `openbot password reset` remains a password-only alias.
Every credential change signs out all desktop and mobile sessions. Use `openbot setup --advanced` to override the hostname, port,
time zone, model, reasoning effort, or concurrent bot job limit.

`uninstall` preserves configuration and Docker volumes so `start` can recover the same installation.
`uninstall --purge` permanently deletes PostgreSQL, Pi sessions and OAuth, agent data, and workspace
files. Released Compose configuration and checksums come from the matching GitHub Release; container
images come from GHCR. Model authentication remains an onboarding step and is reported separately by
`doctor`.

## Start the development stack

Prerequisites: Docker Desktop or another Docker Compose implementation, plus [Bun](https://bun.com/) for the native Electron workflow.

```sh
cp .env.example .env
```

Replace `OPENBOT_CONTROL_TOKEN` and `OPENBOT_AUTH_SECRET` with different random values, for example
from `openssl rand -hex 32`, then build and start the persistent services:

Set `OPENBOT_TIME_ZONE` to the installation's IANA time zone (for example,
`America/New_York`). Desktop user messages also carry the viewer's detected IANA zone so bot turns
retain the sender's local timestamp.

```sh
bash scripts/compose.sh up --build -d
bash scripts/compose.sh ps
```

Create or replace the development owner login (the prompt hides the password):

```sh
bun run auth:setup
```

Authenticate Pi once with the OpenAI Codex provider:

```sh
bash scripts/compose.sh exec computer openbot-pi-login
```

The login command offers browser login and a headless device-code flow. Complete the OpenAI sign-in in the browser; never put the token in `.env`. Pi stores and refreshes its OAuth credential under `/home/box/.pi/agent/auth.json` inside the private `openbot_computer_home` volume. OpenBot exposes only `ready`/`missing` runtime state to Electron.

Verify the stack and open the native client:

```sh
curl http://127.0.0.1:8787/api/v0/health
bun install --frozen-lockfile
bun run desktop
```

To try the development UI from another device on the same Tailscale network, keep the Compose
stack running and start the renderer on this Mac's Tailscale address:

```sh
bun run desktop:tailscale
```

Open the printed `http://<tailscale-ip>:5173` URL on the other device. The dev server proxies the
API, event stream, screen previews, and noVNC WebSockets, so Compose continues to publish its API
and viewer ports only on loopback. The OpenBot API requires the owner login, but noVNC viewer ports
still have no independent login, so use a restrictive Tailscale ACL and stop the dev server afterward.

The server publishes `127.0.0.1:8787`; bot viewers use the loopback-only range
`127.0.0.1:6200-6299`. PostgreSQL, raw VNC, and the computer gateway remain private to Compose.
Better Auth protects the product API, while noVNC endpoints have no independent authentication, so
do not publish the viewer ports to an untrusted network.

Without Pi OAuth, CRUD and history still work and the desktop reports `Pi missing`, but model turns cannot execute. Authenticate before creating bots or sending work.

## Everyday commands

```sh
bun run check
bun run db:generate
bun --filter @openbot/desktop package
bash scripts/compose.sh logs -f server worker computer
bash scripts/compose.sh down
```

Closing Electron never stops a turn. The server, worker, Pi session, and graphical computer live in Compose; Electron only observes and controls them.

Bots use `Read` and `Shell` inside the shared Linux computer. The legacy physical-host bridge remains
an application implementation detail but is deliberately absent from the model tool catalog.

## Plugin marketplace

OpenBot ships its own first-party plugin marketplace. The server does not fetch Cursor's catalog or
plugin packages. Bundled releases live in `apps/server/src/plugins/catalog.ts`; installation
snapshots the complete release manifest so later catalog edits do not silently change an installed
plugin.

A self-hosted deployment can replace the bundled catalog with a schema-versioned JSON manifest by
setting `OPENBOT_MARKETPLACE_FILE` to an absolute path mounted into the server container. The file
uses the normalized `OpenBotMarketplaceManifest` shape defined in
`apps/server/src/plugins/openbot-marketplace.ts`. Restart the server after changing the file. Plugin
execution remains unchanged: remote HTTP MCP runs through the server and local stdio MCP runs on
the shared computer.

## Agent-data files

Every Bot has a readable, hand-editable compatibility tree under
`/home/box/sand-data/agents/<bot-id>` (also reachable through the root-owned
`/home/box/agent-data` symlink). It contains `profile.json`, `settings.json`, an optional canonical
`avatar.<png|jpg|jpeg|webp|gif|svg>`, Markdown memory, routine `automation.json` files, `store.db`,
and after first wake `conversation-blobs.db`. Saved skills are global under
`/home/box/sand-data/workflows/<slug>/SKILL.md`. Shared user memory uses writer shards under
`/home/box/sand-data/user-memory/by-agent`; project memory is sharded by Bot under
`/home/box/sand-data/projects`.

OpenBot imports stable hand edits before constructing the next bot prompt; the
files are live state, not disposable projections. Official UI/API/agent writes
use atomic same-directory renames. Deleting a memory bullet forgets that
occurrence, deleting a skill or automation folder removes that item, and deleting
`runs.json` clears only the file-backed run ledger. Missing or syntactically
invalid `profile.json` is regenerated. Malformed present settings are preserved
and use defaults without a warning, while malformed skills and automations are
preserved and reported rather than silently overwritten.
Prompt-visible profile, memory, and skill catalogs remain frozen until the next
conversation compaction, with identity changes announced immediately. Saved
skills appear in tagged user-info as name, description, and `SKILL.md` path;
their bodies stay on disk and are read only when needed.

User memory intentionally remains one global namespace, saved skills are computer-global,
and avatar installation copies validated bytes into the Bot directory; no
external path pointer remains. Root `settings.json`, `agents/active-agent.json`,
per-bot `projects.json`, project `project.md`, group files, attachment files,
automation run ledgers, and action audit JSONL use the same tree.

The current file, runtime, and reconciliation contract—and its remaining
implementation-level boundaries—is documented in
`plans/35-grok-filesystem-runtime-parity.md`. Plan 32 is retained only as the
historical design record it supersedes.

## Persistence and recovery

The independent stores are:

- PostgreSQL: bots, UI conversations, visible chat, runs, inbox/outbox, leases, and replay events
- `openbot_computer_home`: Pi OAuth and sessions, Bot display mappings, Chrome profiles, and computer-level application state
- `openbot_agent_data`: editable durable-state projections and safe transcript mirrors
- `openbot_workspace`: shared files for all Bots and rooms
- `openbot_box_store`: content-addressed snapshot blobs plus the etag/CAS manifest

These form one recovery set. Worker restarts recover expired per-bot leases and pg-boss retries interrupted wakes. A runtime crash is surfaced as interrupted; OpenBot does not claim exactly-once model execution.

Create a coordinated backup:

```sh
sh scripts/backup.sh
```

For the cleanest backup, stop new message submission and let active runs finish. Restore Postgres, `openbot_computer_home`, `openbot_agent_data`, `openbot_workspace`, and `openbot_box_store` together, then verify runtime health, Bot session continuity, visible history, agent-data reconciliation, and shared files before accepting work.

## Session and compaction semantics

- A context allocates a durable Pi session ID on its first wake.
- The worker passes the stored session path on every later wake.
- Pi reopens the append-only JSONL tree and appends the new addressed input.
- A direct user message sent during an active user run is durably recorded, then steered into that
  Pi run before its next model call. If Pi never confirms delivery, the inbox entry is promoted to
  a normal queued run.
- A direct user message preempts active peer, group, or bootstrap work instead of changing that
  delivery's channel attribution. Peer and group messages remain asynchronous fresh turns.
- DM, group, peer, and onboarding origin remain explicit in the wake envelope and Postgres audit log.
- At most one turn runs for a bot at a time; other wakes remain in its mailbox, and the computer service also rejects concurrent access to one context.
- OpenBot starts a background self-summary near the Grok thresholds and adopts it automatically through Pi's compaction lifecycle. Turn, image, and provider-overflow fallbacks use the same durable archive path.
- A durable intent bridges Pi's append and the atomic archive-manifest commit;
  restart preflight replays only an intent whose compaction ID exists in the Pi
  session and discards an unmatched intent.
- Production exposes no manual Compact button, slash command, or HTTP endpoint.
- Compaction never deletes the visible Postgres transcript or group-room history.

## Testing

```sh
bun test
```

The durable lifecycle integration test uses PostgreSQL and a deterministic fake Pi computer stream:

```sh
createdb openbot_test
DATABASE_URL=postgresql://localhost/openbot_test bun run db:deploy
OPENBOT_TEST_DATABASE_URL=postgresql://localhost/openbot_test \
  bun test apps/worker/test/lifecycle.integration.test.ts
```

It covers wake idempotency, streamed assistant projection, restart persistence, stable per-bot session resume, duplicate-safe agent DMs, transcript isolation, and ordered/recoverable group rounds. The graphical acceptance path validates Chromium, Thunar, screenshots, mouse/keyboard input, shared files, separate displays, and human takeover. Focused browser-use tests validate the exact tool catalog and CDP restrictions; the live smoke follows navigate → snapshot/ref → click → CDP verification against Chromium.

Renderer performance diagnostics remain local:

```js
window.openbotPerformance.summary();
window.openbotPerformance.snapshot();
window.openbotPerformance.clear();
```

## Runtime references and pins

- [Pi monorepo and SDK](https://github.com/earendil-works/pi)
- [Pi SDK guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- [Pi session format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sessions.md)
- [Pi compaction](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md)
- [OpenAI Codex authentication](https://learn.chatgpt.com/docs/auth)
- AI Elements source revision: `apps/desktop/AI_ELEMENTS_REVISION.md`
- Canonical migration decision: `plans/27-pi-agent-runtime.md`

`packages/codex-client` is retained only as unused migration history; no runtime service imports it, no image installs Codex CLI, and all live turns use the embedded Pi SDK.
