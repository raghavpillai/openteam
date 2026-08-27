# OpenBot v0

OpenBot is a self-hosted, desktop-first home for durable Pi agents backed by OpenAI Codex. Each bot owns exactly one persistent Pi JSONL session, one Postgres inbox, its standing instructions, and a persistent graphical Linux screen. DM, peer, group, and bootstrap wakes all enter that same bot session; UI conversations are delivery views, not separate model threads.

Every bot works on the same persistent Linux computer and `/workspace`, so files written by one are immediately visible to the others. Bots get independent 1280×800 XFCE displays with Chromium, Thunar, XFCE Terminal, screenshots, structured mouse/keyboard actions, and live noVNC takeover. Chromium profiles are separately writable while the computer-level browser broker synchronizes ordinary sign-in cookies.

## What is implemented

- Bun 1.3.8 + Turborepo TypeScript monorepo
- Effect-based application and service boundaries
- Prisma 7.9.1, PostgreSQL, and pg-boss 12.28.0 durable mailboxes
- Pi `@earendil-works/pi-coding-agent` 0.84.3 embedded through its TypeScript SDK
- one append-only Pi session tree per bot, reopened after worker, gateway, and Compose restarts
- OpenAI Codex OAuth through Pi's `openai-codex` provider
- Pi-native automatic and manual context compaction; OpenBot does not rebuild model context from UI messages
- the exact ten native tools from the supplied contract: `SendMessage`, `ReactToMessage`, `update_state`, `ExternalShell`, `ExternalRead`, `Shell`, `Read`, `Screenshot`, `GetDynamicTools`, and `CallDynamicTool`
- OpenBot-only dynamic discovery and dispatch; `openbot` exposes `Computer` and `SendToAgent`, while `cursor` exposes only the approved nine-tool compatibility slice: `TodoWrite`, `Task`, `CheckSubagent`, `MessageSubagent`, `StopSubagent`, `CreateAgent`, `UpdateAgent`, `CreateChannel`, and `UpdateChannel`
- durable parent-owned subagents backed by hidden Pi actors, persistent sessions/mailboxes, a bounded concurrent worker pool, image forwarding and bounded video-frame extraction, live status/transcripts, steering, cancellation, resume, and private completion wakes; `computerUse` gets direct screenshot/pixel control while `browserUse` gets a direct 15-tool Playwright/CDP page-control surface
- typed, audited agent/channel administration plus durable per-agent todo queues
- durable scheduled routines created and managed through `update_state`, with a once-per-minute pg-boss dispatcher and execution history
- durable direct-agent channels and restart-safe ordered group rounds
- one shared Debian XFCE computer with bot-specific displays, browser profiles, and input leases
- persistent `/workspace/bots/<bot>`, `/workspace/projects/<group>`, and `/workspace/shared` folders
- Electron 43, React 19, Tailwind 4, shadcn/ui, and source-owned AI Elements adaptations
- snapshot + replayable SSE client state, streamed messages and activity, stop, bot CRUD, runtime health, and an interactive desktop viewer

## Architecture

```text
Electron (lightweight native client; no model credentials)
        ├── optional, approval-gated physical-host bridge
        │ localhost HTTP + SSE
        ▼
server ───── PostgreSQL + pg-boss
                  │ durable wake
                  ▼
               worker ── one active turn lease per bot
                  │ private token + NDJSON
                  ▼
computer gateway ── embedded Pi AgentSession
        │                 └── openai-codex OAuth provider
        ├── /home/openbot/.pi/agent
        │     ├── auth.json
        │     └── sessions/openbot/<bot-session>.jsonl
        ├── /workspace
        │     ├── bots/<bot>
        │     ├── projects/<group>
        │     └── shared
        └── ScreenBroker
              ├── bot A display :100 → noVNC :6200
              ├── bot B display :101 → noVNC :6201
              └── BrowserBroker → encrypted shared cookie authority
```

Postgres is authoritative for product state, mailboxes, visible chat, group delivery, run audit, and client replay. Pi's JSONL file is authoritative for that bot's model-visible history and compaction tree. A group wake may temporarily use a project directory as its cwd, but it resumes the same bot session.

## Start the stack

Prerequisites: Docker Desktop or another Docker Compose implementation, plus [Bun](https://bun.com/) for the native Electron workflow.

```sh
cp .env.example .env
```

Replace `OPENBOT_CONTROL_TOKEN` with a random local value, for example from `openssl rand -hex 32`, then build and start the persistent services:

Set `OPENBOT_TIME_ZONE` to the installation's IANA time zone (for example,
`America/New_York`). Desktop user messages also carry the viewer's detected IANA zone so bot turns
retain the sender's local timestamp.

```sh
bash scripts/compose.sh up --build -d
bash scripts/compose.sh ps
```

Authenticate Pi once with the OpenAI Codex provider:

```sh
bash scripts/compose.sh exec computer openbot-pi-login
```

The login command offers browser login and a headless device-code flow. Complete the OpenAI sign-in in the browser; never put the token in `.env`. Pi stores and refreshes its OAuth credential under `/home/openbot/.pi/agent/auth.json` inside the private `openbot_computer_home` volume. OpenBot exposes only `ready`/`missing` runtime state to Electron.

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
and viewer ports only on loopback. OpenBot v0 has no user login; anyone permitted to reach this Mac
on the tailnet can control it, so use a restrictive Tailscale ACL and stop the dev server afterward.

The server publishes `127.0.0.1:8787`; bot viewers use the loopback-only range `127.0.0.1:6200-6299`. PostgreSQL, raw VNC, and the computer gateway remain private to Compose. v0 has no OpenBot user login, and the noVNC endpoints have no independent authentication, so do not publish these ports to an untrusted network.

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

`ExternalRead` and `ExternalShell` are the exception: they target the physical host rather than the
shared Linux computer, so the native desktop must be open. Every host read or command presents an
OS-native approval dialog, and the authenticated bridge never mounts the host home into Compose.
Use `Read` and `Shell` for ordinary always-on work inside the shared OpenBot computer.

## Agent-data files

Every bot has a readable, hand-editable compatibility tree under
`/home/openbot/agent-data/agents/<bot-id>`. It contains `profile.json`,
`settings.json`, an optional canonical `avatar.<png|jpg|jpeg|webp|gif|svg>`,
Markdown memory, per-bot `SKILL.md` files, and
routine `automation.json` files. Shared user memory lives under
`/home/openbot/agent-data/user-memory`; project memory is sharded by bot under
`/home/openbot/agent-data/projects`.

OpenBot imports stable hand edits before constructing the next bot prompt; the
files are live state, not disposable projections. Official UI/API/agent writes
use atomic same-directory renames. Deleting a memory bullet forgets that
occurrence, deleting a skill or automation folder removes that item, and deleting
`runs.json` clears only the file-backed run ledger. Missing or syntactically
invalid `profile.json` is regenerated, while malformed present settings, skills,
and automations are preserved and reported rather than silently overwritten.
Prompt-visible profile, memory, and skill catalogs remain frozen until the next
conversation compaction, with identity changes announced immediately.

User memory intentionally remains one global namespace, saved skills remain per
bot, and avatar installation copies validated bytes into the bot directory; no
external path pointer remains. Root `settings.json`, `agents/active-agent.json`,
per-bot `projects.json`, project `project.md`, group files, attachment files,
automation run ledgers, and action audit JSONL use the same tree.

The complete file and reconciliation contract is documented in
`plans/32-agent-data-filesystem-parity.md`.

## Persistence and recovery

The four independent stores are:

- PostgreSQL: bots, UI conversations, visible chat, runs, inbox/outbox, leases, and replay events
- `openbot_computer_home`: Pi OAuth and sessions, bot display mappings, browser profiles, and computer-level application state
- `openbot_agent_data`: editable durable-state projections and safe transcript mirrors
- `openbot_workspace`: shared bot and project files

These form one recovery set. Worker restarts recover expired per-bot leases and pg-boss retries interrupted wakes. A runtime crash is surfaced as interrupted; OpenBot does not claim exactly-once model execution.

Create a coordinated backup:

```sh
sh scripts/backup.sh
```

For the cleanest backup, stop new message submission and let active runs finish. Restore Postgres, `openbot_computer_home`, `openbot_agent_data`, and `openbot_workspace` together, then verify runtime health, bot session continuity, visible history, agent-data reconciliation, and shared files before accepting work.

## Session and compaction semantics

- Bot creation allocates a durable Pi session ID on its first wake.
- The worker passes the stored session path on every later wake.
- Pi reopens the append-only JSONL tree and appends the new addressed input.
- A direct user message sent during an active user run is durably recorded, then steered into that
  Pi run before its next model call. If Pi never confirms delivery, the inbox entry is promoted to
  a normal queued run.
- A direct user message preempts active peer, group, or bootstrap work instead of changing that
  delivery's channel attribution. Peer and group messages remain asynchronous fresh turns.
- DM, group, peer, and onboarding origin remain explicit in the wake envelope and Postgres audit log.
- At most one turn runs for a bot at a time; other wakes remain in its mailbox.
- Pi automatically compacts near the context threshold and records the compaction in the same session tree.
- Manual “Compact context” invokes Pi's compaction API on that same file.
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
