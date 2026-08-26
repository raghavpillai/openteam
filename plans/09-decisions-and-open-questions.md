# Decisions and open questions

Status: historical pre-implementation decision snapshot; superseded where noted  
Last updated: 2026-08-25

> Do not use this file as current runtime or scope guidance. OpenBot now embeds Pi rather than Codex app-server, and agent DMs, group chats, graphical screens, BrowserBroker, onboarding, and non-routine `update_state` are implemented. Start with `30-canonical-context-handoff.md`; use `18-v0-implementation-status.md`, `19-agent-interaction-implementation.md`, `20-graphical-computer-implementation.md`, `21-shared-workspaces-and-browser-authority.md`, `25-grok-new-bot-onboarding-research.md`, `27-pi-agent-runtime.md`, and `29-update-state-manifest.md` for current behavior.

## Settled for v0

### Product

- One implicit local user; no OpenBot auth.
- Bots are the primary navigation object.
- Each bot has one exposed default conversation; storage supports more.
- No plugins, bot-to-bot/group messaging, routines, voice, attachments, semantic memory, or native host control.
- The Grok references guide layout and interaction only; OpenBot gets original branding and visuals.

### Runtime

- Codex app-server is the driver.
- One supervised app-server process serves v0 conversations.
- Direct stdio JSON-RPC/JSONL, not experimental WebSocket transport.
- Stable protocol only, pinned version, committed generated types.
- One conversation maps to one native Codex thread.
- One active turn per conversation.
- Native Codex context/compaction; no second memory engine.
- One active bot owns one hot/subscribed Codex home thread in the local v0. Loaded means ready, not continuously generating; cold resume remains a supported recovery path.

### Data

- PostgreSQL through Prisma for product state.
- `InboxEvent`, `BotRunLease`, and `OutboxDelivery` are authoritative durable-agent records. pg-boss provides transactional wake jobs, retries, heartbeats, scheduling, and dead letters.
- Separate named storage for Postgres, Codex home, shared computer home, and shared `/workspace`.
- Product events are replayable by monotonic sequence.
- Completed Codex items override provisional deltas.
- Missing native rollout produces a detached conversation, never silent replacement.

### App and infrastructure

- Bun monorepo, Turborepo, TypeScript, Effect, Electron.
- Electron uses a React 19 + Vite renderer with Tailwind CSS 4, shadcn/ui CSS variables, and selected source-owned AI Elements components.
- OpenBot's HTTP/SSE reducer remains the UI state/transport boundary; Electron does not use AI SDK `useChat` or AI Gateway as a second runtime and holds no model credential.
- AI Elements supplies conversational primitives. OpenBot supplies the desktop shell, bot rail, activity inspector, future remote-screen viewer, peer/channel surfaces, and domain adapter.
- Do not add Next.js solely for AI Elements. Prove and pin the selected registry source under Electron/Vite before building the full shell.
- Server, pg-boss worker, shared Linux computer, and Postgres run in one Compose stack; Electron is a separately launched native client.
- The unauthenticated API binds to localhost by default.
- One installation/user gets one shared headless computer in v0. Bots share files and computer-level CLI state while retaining separate conversations. Browser/login state and bot-specific screens join that same computer boundary in the first post-v0 graphical milestone.
- Separate graphical bot screens will be logical displays/work surfaces inside that shared computer boundary, not per-bot filesystems or default per-bot containers. A browser/session broker must safely expose computer-scoped authentication without concurrent independent Chrome processes writing one profile.

## Settled for post-v0 plugins

- MCP is the connector/runtime protocol, not the whole plugin system.
- Agent Plugins 1.0 is the preferred portable package format; Codex, Claude Code, and Cursor packages may be imported through constrained adapters.
- OpenBot owns its marketplace sources, installs, updates, account connections, credential vault, bot grants, tool policy, approvals, and audit.
- Plugin installs and account connections are installation/user-scoped. Skill enablement and named connection grants are bot-scoped.
- Installation does not authorize OAuth or trusted code execution. Uninstall and account revocation are separate confirmed operations.
- Local stdio MCP servers, hooks, and other executable components are denied until a later explicit trust/isolation design.
- Codex app-server remains the driver, but OpenBot does not use its plugin APIs while they are documented as under development.
- Details and staged acceptance criteria live in `11-plugin-architecture-research.md`.

## Settled for post-v0 agent communication

- `SendToAgent` is a durable fire-and-forget peer/group send. It returns an acknowledgement, never the recipient's reply.
- A reply is a new message that wakes the original sender on a fresh turn; agents do not wait or poll in the sending turn.
- PostgreSQL is the first mailbox/delivery queue, using transactional direct-delivery enqueue or group-round creation, worker leases, and deduplicated tool calls.
- Each bot has one active turn across user, peer, group, routine, and background origins.
- User work outranks peer work. Normal peers wait but run ahead of routines; priority 1:1 peers may interrupt only non-user turns and groups ignore priority.
- Sender identity is bound by the host's bot-scoped capability and never accepted from model arguments.
- Direct/group transcripts are authoritative channel projections and appear as compact events in each bot's home conversation.
- Peer content is untrusted data and cannot expand tools, permissions, approvals, secrets, or durable instructions.
- The observed `SendToAgent` and `SendMessage` schemas are preserved verbatim in `12-agent-communication.md`.
- Group rooms use deterministic sequential rounds: each eligible bot gets a separate turn, later bots see earlier same-round replies, and silence is a successful outcome.
- Unmentioned group messages select all active members; mentions narrow eligibility. Bot outputs inside a round do not recursively reopen that round.
- Group/peer/background turns publish only through explicit `SendMessage`; the direct-user fallback for ordinary Codex agent messages does not apply.
- The two user-supplied group-wake JSON sketches are preserved verbatim and interpreted in `15-agent-group-chat-runtime.md`.

## Settled for native tools

- OpenBot covers the ten observed capability classes but does not reproduce ten unrestricted wrappers.
- Codex owns model-facing `Shell` and `Read` on the shared computer; the computer service owns `Screenshot`.
- OpenBot owns `SendMessage`, `ReactToMessage`, peer delivery, and typed durable-state commands with host-bound caller identity.
- A broad `update_state` shape may exist as a compatibility facade only after typed domain commands and target/action validation exist.
- `GetDynamicTools` sees only the caller bot's effective catalog. `CallDynamicTool` re-authorizes every invocation and cannot bypass install, connection, grant, approval, or bridge policy.
- Direct typed MCP tools are preferred when practical; app-server experimental `dynamicTools` is not a dependency.
- `ExternalRead` and `ExternalShell` remain absent until an enrolled, revocable physical-host bridge exists. A host-home mount is not an acceptable substitute.
- The omitted routine `trigger` union is not needed for the MVP plan and will be reconsidered when routines and connector events are designed.
- Exact observed descriptor content and the staged acceptance plan live in `13-native-tool-surface.md`.

## Settled for scheduled routines

- Scheduled routines are per-bot background wakes into the same durable inbox, strict bot lease, Pi session, workspace, screen, and home-DM delivery path used by other origins.
- PostgreSQL owns routine definitions, revision history, next-run time, and execution history. One pg-boss minute tick wakes a database dispatcher; pg-boss's private schedule table is not the per-routine source of truth.
- The first milestone supports five-field cron, IANA time zones, friendly aliases, and fixed `@every` intervals. Connector/event triggers remain deferred.
- Missed runs have a bounded grace window and do not replay without limit. The same routine never overlaps itself.
- Routine output is visible only through `SendMessage`; hidden system wakes and ordinary model text never appear as user-authored chat.
- Typed routine commands ship before the `routine` branch of the compatible `update_state` facade. The full supplied shape is preserved in `29-update-state-manifest.md`.
- Exact lifecycle, dispatch, safety, UI, and acceptance semantics live in `28-scheduled-routines.md`.

## Defaults that can change without redesign

These are implementation defaults, not permanent product promises:

- macOS as the first manually tested desktop target.
- API-key-based upstream authentication supplied by the deployment operator.
- one default model chosen through server configuration;
- one shared headless computer/runtime with bot default directories used for organization, not isolation;
- HTTP JSON commands plus SSE events;
- system-generated conversation title after the first completed turn, or the first user-message excerpt if title generation would add cost/latency.

## Questions to answer during the runtime spike

### Bun and app-server process behavior

Can Bun reliably handle the long-lived child process, newline framing, backpressure, signals, and many pending JSON-RPC requests on every supported target?

Default response if no: run only the adapter as a small Node sidecar. Keep OpenBot domain/server code on Bun.

### Authentication bootstrap

Does the server image receive a standard environment-based API key directly, or should it call app-server's account login surface on boot?

Default: deployment secret/environment path, with only safe readiness state exposed. Do not build login UI in v0.

### Headless approval timeout

How long should a run wait when Electron is disconnected and Codex requests approval?

Default: leave it visibly waiting while the server process is healthy; do not auto-accept. On runtime/server restart, mark the run interrupted and the approval expired. Add an operator-configurable timeout later.

### Bot instruction injection

Which stable field in the pinned generated app-server schema should carry a bot's persona independently of shared project instructions?

Default: keep the persona in Postgres and inject it through supported thread configuration or explicit initial thread context. Treat project `AGENTS.md` files as shared project state and never rewrite them to edit a bot.

### Post-v0 parallel screens and browser state

Which display and browser broker gives each bot a separate work surface while sharing one computer's browser authentication safely?

Default: answer this only after the v0 release gate. Spike multiple approaches from `10-grok-computer-research.md`. Do not run independent Chrome processes against the same writable profile directory without proving locking and recovery behavior.

### Renderer availability for self-hosting

Should the server also host a browser build of the renderer so `docker compose up` is usable without Electron?

Default: not in v0. It adds a second supported client surface. Compose is the always-on service stack; Electron is the intended client.

### AI Elements under Electron/Vite

Do the pinned `conversation`, `message`, `prompt-input`, `tool`, `confirmation`, `code-block`, and `terminal` registry sources typecheck, render, and package with React 19, Tailwind 4, strict CSP, and no Next.js?

Default: patch source-owned components behind OpenBot wrappers or pin the last compatible registry revision. Do not add Next.js, adopt `useChat`, or move model credentials into Electron to satisfy example code.

### Bot-scoped control-plane capability

Can the pinned stable app-server bind a separate internal MCP capability/configuration to each bot thread while one process hosts several bots?

Default: prove it in a spike. If the server cannot establish non-forgeable caller identity from the exact schema, use lazily started per-bot app-server process/configuration directories. Do not add a model-supplied `sender_id` or rely on renderer filtering.

## Product questions that can wait until after v0

- Should a bot expose many named conversations or remain one continuous chat?
- Is memory explicit (`Remember this`) or automatically curated, and is it per bot or per user?
- Should OpenBot later offer an explicitly private computer mode in addition to the default shared computer?
- Can bots attach existing repos into `/workspace`, and how are ownership and backup represented?
- What automatic inactivity/failure-streak pause policy should follow the explicit first-release routine semantics?
- Does a native host bridge support files/shell first or full computer use?
- Which encrypted credential-vault implementation best fits a single-Compose self-hosted install while supporting rotation and backup?
- Which reverse-domain namespace will OpenBot control for Agent Plugins extension metadata?
- Should the first curated connector OAuth flow use loopback/deep-link callbacks, operator-registered HTTPS redirects, or both?
- Is the desktop a local-only client or can it connect to remote OpenBot servers?
- What data/export format makes a bot portable between servers?
- After direct/group messaging is stable, should OpenBot add synchronous delegated subtasks as a separate primitive?
- What is the license and contribution model?

## Risks and mitigations

### Evolving Codex protocol

Risk: app-server evolves faster than the product.

Mitigation: pin the binary, generate matching types, remain on stable methods, add protocol fixtures, and upgrade deliberately.

### Dual persistence

Risk: Postgres transcript, Codex rollout, shared workspace, and computer-home/browser state drift after crashes.

Mitigation: define source-of-truth rules, persist native IDs early, make recovery explicit, and back up the database plus all durable computer volumes together.

### Misleading "always-on" language

Risk: users infer control of their physical computer.

Mitigation: call the target `OpenBot computer`, state that it is a remote/self-hosted Linux computer shared by bots, and show a real selected-bot screen only when the graphical service exists.

### No app auth

Risk: accidental LAN/public exposure gives anyone agent and filesystem access.

Mitigation: localhost bind, clear warnings, no public deployment guide, conservative sandbox, and no host mounts or Docker socket.

### Shared-computer expectations

Risk: users treat separate bots or screens as private security boundaries even though shared files, logins, and credentials are intentional.

Mitigation: explain the sharing in bot creation and computer UI, enforce one computer-level sandbox, run non-root with no broad host mounts, and add private computers only as an explicit future mode.

### Graphical/browser concurrency

Risk: separate screens corrupt a shared Chrome profile, steal window focus, or leak input between bot sessions.

Mitigation: require the dedicated computer spike, a brokered browser/session design, bot-scoped input leases, recovery tests, and a global emergency stop before shipping screen takeover.

### Electron security

Risk: renderer compromise gains local privileges.

Mitigation: context isolation, no Node integration, narrow validated preload surface, strict content policy, and server-side authorization of every filesystem/runtime action even in a one-user product.

### Autonomous bot loops

Risk: two bots repeatedly wake one another, multiplying model usage and external actions without user intent.

Mitigation: correlation IDs, hop/message budgets, TTL, rate limits, self-send rejection, user-visible chain controls, and unchanged approval requirements for peer-triggered work.

## Next decision gate

The repository can be scaffolded with the defaults above. Pause for a product decision if the runtime spike disproves direct Bun-to-app-server integration or v0 must control the user's physical computer; either outcome changes a core process/security boundary. A failed graphical spike blocks graphical-computer parity, not the headless v0 release.
