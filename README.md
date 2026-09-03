# OpenBot v0

OpenBot is a self-hosted, desktop-first home for durable Pi agents with independently configurable inference providers. Each Bot owns one home Pi context, one Postgres inbox, Grok-compatible file state, and a persistent graphical Linux screen. Direct, peer, room, routine, bootstrap, and subagent-completion wakes all resume the member Bot's home context.

Every Bot works as the unprivileged `runner` user (uid 1001, shared gid 1000) on the same persistent Linux computer and starts in `/workspace`, so files written by one are immediately visible to the others. The Pi supervisor owns inference credentials that `runner` cannot read. Bots get independent 1280×800 XFCE displays with Google Chrome, Thunar, XFCE Terminal, screenshots, structured mouse/keyboard actions, and live noVNC shared control. Chrome profiles and sign-ins are computer-scoped and persist under `/home/box/chrome-profile[-N]`.

## What is implemented

- Bun 1.3.8 + Turborepo TypeScript monorepo
- Effect-based application and service boundaries
- Prisma 7.9.1, PostgreSQL, and pg-boss 12.28.0 durable mailboxes
- Pi `@earendil-works/pi-coding-agent` 0.84.3 embedded through its TypeScript SDK
- one append-only Pi session tree per bot context, reopened after worker, gateway, and Compose restarts
- provider-qualified Pi models with OAuth/subscription and API-key authentication
- built-in OpenAI Codex, OpenAI API, and Anthropic providers, plus custom OpenAI-, Anthropic-, or Google-compatible endpoints
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
computer gateway ── embedded Pi AgentSession (the only runtime engine)
        │                 └── provider credentials + model execution
        ├── /home/box/.pi/agent
        │     ├── auth.json
        │     ├── sessions/openbot/<context-session>.jsonl
        │     └── context-sessions/<context-session>/manifest.json + blobs/
        ├── /home/box/sand-data
        │     ├── settings.json (active provider, model, and reasoning)
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

Shared code follows strict dependency layers:

- `packages/contracts` owns serializable API, event, routine, preference, capability, and internal service protocol types plus boundary parsers.
- `packages/client-core` is a platform-neutral HTTP/SSE API client. It contains transport behavior only, not product workflows or UI state.
- `packages/product-core` owns pure client-side projections such as snapshot indexing, message/thread derivation, and reconciliation.
- `packages/design-tokens` owns renderer-neutral theme values and avatar artwork data; desktop and mobile render those values with their own platform primitives.
- desktop, iOS, and landing remain clients: they own platform UI, lifecycle, storage, and integration adapters but do not import database or server-domain code.
- `packages/messaging` and the server/worker/computer apps retain domain execution, persistence, orchestration, and privileged tools.

`bun run check:architecture` enforces these import directions, contract/database enum parity, and the absence of server tool catalogs from the built mobile bundle.

## Install the released server stack

Install Docker with Compose 2.20 or newer, plus either Bun or Node 20.17+. Then install and configure
the versioned server, worker, PostgreSQL database, migrations, and shared graphical computer with Bun:

```sh
bunx --bun @openbot/cli install
```

The same CLI can run through Node/npm:

```sh
npx @openbot/cli install
```

The installer verifies Docker and the host, generates private installation secrets, verifies the
release bundle checksum and Sigstore identity, pulls digest-pinned `linux/amd64` or `linux/arm64`
images, opens the staged setup in the same command, starts the selected Compose deployment in the
background, and verifies local and public readiness. Run diagnostics and manage the installation with:

```sh
bunx --bun @openbot/cli doctor
bunx --bun @openbot/cli setup
bunx --bun @openbot/cli status
bunx --bun @openbot/cli stop
bunx --bun @openbot/cli start
bunx --bun @openbot/cli logs
bunx --bun @openbot/cli provider list
bunx --bun @openbot/cli provider login
bunx --bun @openbot/cli model list
bunx --bun @openbot/cli model use openai-codex gpt-5.5
bunx --bun @openbot/cli account update
bunx --bun @openbot/cli password reset
bunx --bun @openbot/cli update
bunx --bun @openbot/cli uninstall
```

The Electron app exposes the same managed update from **Settings → Updates**. For a loopback server
installed in the current user's OpenBot directory, the desktop runs its bundled CLI updater. For a
server on another computer, enter an SSH destination such as `owner@openbot-host`; OpenBot uses the
operating system SSH agent, requires an existing `known_hosts` entry, and runs the same CLI without
storing a password or granting the web server Docker access. If SSH has not been configured, the UI
offers a copyable command. Update progress covers verification, backup, image pull, restart,
readiness, and configuration rollback. The CLI persists the latest job record for diagnostics and
reconnecting management tools.

Before changing the stack, the updater acquires a cross-process lock, validates free disk and the
next Compose configuration, rejects unexpected downgrades or prereleases, pulls the next images,
briefly stops writers, and writes a PostgreSQL dump under the installation's `backups` directory.
If startup fails after migrations begin, it restores both the old Compose configuration and database
before restarting the old release. A successful update must report `ready` from the
requested release after Compose has confirmed the server, worker, computer, database, and migration
states. Patch releases in a compatible protocol line are advisory rather than blocking; the client
shows a blocking banner only when the client, server, or API protocol falls outside the published
compatibility window. Signed desktop releases download in-app and install after an explicit restart.

The staged setup inside `openbot install` offers bundled public HTTPS, an existing HTTPS reverse
proxy or load balancer, public HTTP, private-network, and loopback access before creating the single OpenBot username/password account and
selecting and configuring the Pi inference provider and provider-qualified model. Guided setup supports
ChatGPT Plus/Pro OAuth, Claude Pro/Max OAuth, OpenAI and Anthropic API keys, and compatible custom
endpoints with a password or API key. Public HTTPS is the fresh-install default: point a domain's A/AAAA
record at the VM and open inbound TCP ports 80 and 443, and the bundled Caddy container obtains,
renews, and terminates TLS automatically. The VM does not need an existing certificate.
Menu prompts support Up, Down, Left, and Right arrows; press Enter to confirm the highlighted option.

Public HTTP works with a bare VM IP and the configured API port, but setup requires an explicit
acknowledgement because passwords and bearer sessions travel without encryption; iOS rejects that
public cleartext connection. In both Internet-facing modes, the raw noVNC range stays bound to
loopback. Private-network mode can expose it only to a trusted LAN or VPN.

Password input is hidden, is never written to the installation `.env`, and is hashed by Better Auth
in Postgres. `openbot account update` interactively changes both credentials;
`--username <name>` changes only the username, `--password` securely prompts for only a new
password, and the flags can be combined. `openbot password reset` remains a password-only alias.
Every credential change signs out all desktop and mobile sessions. Provider and model selection are
part of normal setup. Use `openbot setup --advanced` to override the hostname, local API port, time
zone, reasoning effort, or concurrent bot job limit.

OpenBot defaults to `OPENBOT_AUTH_MODE=required`. Desktop, iPhone, and headless clients sign in
with the owner username/password and then use the resulting session; no separate API token is
needed. A fully trusted, isolated deployment may explicitly set `OPENBOT_AUTH_MODE=disabled` to
remove product API authentication. Disabled mode grants every client complete API access, so never
use it on an internet-facing host, an untrusted LAN, or behind a proxy that exposes the API.

Re-running `openbot setup` preserves the owner credentials and active sessions. Use it to change
access or runtime settings; use `openbot provider login [provider]` to repair only provider authentication.
`openbot logs --service server --follow` streams a targeted service log when `doctor` identifies a
problem. Existing-proxy mode binds OpenBot to loopback and prints the local HTTP upstream to use;
the proxy must forward WebSocket upgrades as well as ordinary HTTP requests. Configure that proxy
to replace (not preserve) inbound `X-Forwarded-*` headers with values derived from its own connection.

`uninstall` preserves configuration and Docker volumes so `start` can recover the same installation.
`uninstall --purge` permanently deletes PostgreSQL, Pi sessions and OAuth, agent data, and workspace
files. Released Compose configuration, Sigstore bundles, and checksums come from the matching GitHub
Release; immutable container digests resolve to GHCR. Model authentication remains an onboarding
step and is reported separately by `doctor`.

## Start the development stack

Prerequisites: Docker Desktop or another Docker Compose implementation, plus [Bun](https://bun.com/) for the native Electron workflow.

```sh
cp .env.example .env
```

Replace `OPENBOT_CONTROL_TOKEN`, `OPENBOT_AUTH_SECRET`, and `OPENBOT_PROXY_SECRET` with different
random values, for example from `openssl rand -hex 32`, then build and start the persistent services:

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

Authenticate Pi with the default OpenAI Codex provider:

```sh
bash scripts/compose.sh exec computer openbot-pi-auth login openai-codex oauth
```

The OAuth command offers browser and headless device-code flows. Never put provider credentials in `.env`. Pi stores and refreshes credentials under `/home/box/.pi/agent/auth.json` inside the private `openbot_computer_home` volume. The inference supervisor owns that directory; agent shells and graphical apps run as a separate user that cannot read it. The desktop Server settings page drives the same server-owned connection API without returning credential values to the client.

The active provider, provider-qualified model, and reasoning effort are runtime settings in `/home/box/agent-data/settings.json` (the root `settings.json` in the durable agent-data tree). That file is the only source of truth and is updated atomically. Changes from the desktop Server page or `openbot model use` apply to new turns and background inference without restarting services; already-running turns keep the selection they started with. These runtime options are not environment variables or Compose configuration.

Authenticated clients read the provider/model catalog with `GET /api/v0/server-settings`, apply a selection with `PATCH /api/v0/server-settings/inference`, and use the `/api/v0/inference-providers/*` auth-session endpoints to connect or disconnect providers. Auth-session responses contain prompts and connection status, never submitted credential values.

The management CLI discovers authentication methods and models from Pi:

```sh
openbot provider list
openbot provider login anthropic --auth oauth       # Claude Pro/Max
openbot provider login anthropic --auth api-key     # Anthropic API
openbot provider login openai --auth api-key        # OpenAI API
openbot model list anthropic
openbot model use anthropic <model-id> --thinking high
```

Pi reports Anthropic OAuth as Claude Pro/Max subscription authentication. Its current provider integration uses Anthropic paid extra usage for third-party harness traffic rather than included plan limits. API keys and generic provider passwords are prompted without echo and passed over stdin, never command arguments or `.env`.

Add a compatible private gateway or another generic provider with an initial model, then select it:

```sh
openbot provider add acme \
  --name "Acme AI" \
  --base-url https://ai.example.com/v1 \
  --api openai-responses \
  --model acme-pro \
  --reasoning
openbot model use acme acme-pro
```

Supported custom API adapters are `openai-completions`, `openai-responses`, `anthropic-messages`, and `google-generative-ai`. `openbot provider remove <id>` removes a custom provider after another provider is selected.

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

Without authentication for the selected Pi provider, CRUD and history still work and the desktop reports `Pi missing`, but model turns cannot execute. Authenticate before creating bots or sending work.

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
external path pointer remains. Root `settings.json` (including active inference provider, model, and
reasoning), `agents/active-agent.json`,
per-bot `projects.json`, project `project.md`, group files, attachment files,
automation run ledgers, and action audit JSONL use the same tree.

The current file, runtime, and reconciliation contract lives in
`packages/messaging/src/agent-data.ts`, `apps/computer/src/grok-agent-store.ts`,
and their tests. Remaining external-event delivery and routine-safety work is tracked
in `plans/29-update-state-manifest.md` rather than duplicating the completed file-state record.

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
- Open-work index: `plans/00-index.md`
