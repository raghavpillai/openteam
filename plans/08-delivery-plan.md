# Delivery plan

> Implementation update (2026-08-24): Phase 7's first graphical slice has shipped and passed the validation in `20-graphical-computer-implementation.md`. Safe shared browser authentication remains the unfinished part of that phase.

Status: implementation sequence for MVP v0  
Last updated: 2026-08-24

## Principle

Build one restart-safe vertical slice before adding breadth. The first meaningful milestone is not a polished shell; it is a message that travels from Electron to Codex, streams back, persists, and continues after a full service restart.

`16-v0-release-plan.md` is the canonical release summary; this file expands its milestones into implementation phases and test workstreams.

## Phase 1: repository and contracts

Deliver:

- Bun workspace root and lockfile;
- Turborepo task graph;
- strict shared TypeScript configuration;
- `apps/desktop`, `apps/server`, `apps/computer`, and only the v0 packages in `03-system-architecture.md`;
- Electron main/preload/React 19 renderer boundaries with Vite, Tailwind CSS 4, and shadcn CSS-variable setup;
- pinned source copies of the AI Elements `conversation`, `message`, `prompt-input`, `tool`, `confirmation`, `code-block`, and `terminal` components;
- an Electron/Vite compatibility smoke test that succeeds without Next.js or a renderer model credential;
- lint, typecheck, unit-test, build, and dev tasks;
- validated configuration through Effect Schema;
- version policy and environment example with no real secrets.

Exit check:

```text
bun install
bun run typecheck
bun run test
bun run build
```

all succeed from the repository root.

## Phase 2: storage and Compose

Deliver:

- PostgreSQL service and health check;
- server image with pinned Bun plus an initial non-root computer image with pinned Codex CLI/app-server;
- named database, Codex home, shared computer-home, and shared workspace volumes;
- Prisma schema and first migration;
- server migration/startup entrypoint;
- localhost-only port mapping by default;
- readiness and liveness endpoints;
- non-root server user and writable data directories.

Exit check: a clean `docker compose up --build` reaches ready state, survives recreation with volumes intact, and gives a precise not-authenticated runtime state when no upstream credential exists.

## Phase 3: Codex adapter spike

Do this before building most UI.

Deliver:

- committed generated TypeScript app-server schema from the pinned binary;
- Bun child-process stdio transport;
- initialize/initialized handshake;
- request/response correlation;
- notification and server-request routing;
- start thread, resume thread, start turn, interrupt turn, and approval response;
- proof that Codex-owned shell/read activity reaches the projection with the configured sandbox and no duplicate custom execution path;
- an Effect-scoped supervisor with crash/backoff behavior;
- a fake app-server executable or fixture transport for deterministic tests.

Exit check: an integration test starts a real Codex thread when credentials are available; hermetic tests cover the full protocol lifecycle without network access.

This spike is the main technical risk because OpenBot chooses Bun application code while the higher-level Codex SDK documents Node.js. If direct app-server stdio is not reliable under Bun, isolate the adapter in a tiny Node sidecar rather than rewriting the whole server or pretending support.

## Phase 4: server vertical slice

Deliver:

- bot CRUD, shared-computer assignment, and organizational folder provisioning;
- default conversation creation with lazy Codex thread attachment;
- idempotent message command;
- per-conversation active-run lock;
- Codex thread start/resume mapping;
- persisted message, run, run-item, and event projections;
- SSE replay by sequence;
- cancellation and approval commands;
- startup recovery rules;
- sanitized diagnostics.

Exit check: API-level tests create two bots, run independent turns, restart the stack, resume both threads, and prove both bots can intentionally read the same persisted `/workspace` while retaining separate conversations.

## Phase 5: Electron product slice

Deliver:

- secure main/preload/renderer separation;
- bot rail and create-bot sheet;
- empty, streaming, completed, failed, cancelled, and offline conversation states;
- composer;
- command/file/tool activity rows;
- approval card;
- OpenBot run-item adapter composed with AI Elements conversation/message/tool/confirmation/terminal primitives;
- text-only AI Elements prompt input with unsupported demo actions removed;
- bot-computer inspector;
- last-opened bot preference and event-stream reconnection;
- original OpenBot visual tokens in light and dark themes.

Exit check: the end-to-end flows in `02-mvp-v0.md` are usable without developer tools or direct database access.

The packaged desktop must also pass the v0 UI acceptance criteria in `14-electron-ai-elements-ui.md`: no Next.js, no direct model call from Electron, correct streaming/replay projection, production CSP, stable scroll anchoring, and an honest headless activity inspector.

## Phase 6: resilience and handoff

Deliver:

- full restart matrix tests;
- duplicate command/idempotency tests;
- app-server crash tests;
- missing rollout and detached-conversation behavior;
- backup/restore runbook for the database plus Codex, computer-home, and workspace volumes;
- local self-hosting documentation;
- architecture decision records for any deviation from this plan;
- MVP limitations documented in the product and README.

Exit check: all twelve acceptance criteria in `02-mvp-v0.md` pass from a clean checkout. This is the v0 release gate.

## Phase 7: post-v0 shared graphical computer

Begin only after the v0 release gate is green.

Deliver:

- lightweight Linux desktop image with Chrome/Chromium, Thunar, and terminal;
- persistent computer home and browser session store;
- bot-screen/session manager;
- one active computer-use lease per bot screen;
- parallel-screen proof with a shared filesystem;
- browser-session sharing strategy that does not corrupt a Chrome profile;
- screen streaming, human takeover, and reconnect prototype;
- bot-bound, non-interactive screenshot capture stored as an artifact;
- update/recover path that rebuilds the image while preserving durable state.

Exit check: Bot A and Bot B have distinct visible screen states, can work in parallel, see the same file in `/workspace`, and can use an intentionally shared browser login without running unsafe concurrent writers against one profile.

This milestone chooses the display/browser broker described in `10-grok-computer-research.md`. Do not promote an implementation that looks separate in the UI but accidentally creates isolated filesystems or credentials. Until it passes, v0 keeps the activity inspector and makes no graphical-computer claim.

## Phase 8: post-v0 agent communication

Begin only after the Phase 6 v0 release gate is green. Deliver in the sequence defined by `12-agent-communication.md`:

1. the first-party `SendToAgent` control-plane tool with the exact observed schema;
2. durable direct channels, transactional PostgreSQL deliveries, acknowledgements, and restart recovery;
3. a one-active-turn-per-bot scheduler and fresh recipient Codex wakes;
4. later replies, priority supersession, chain budgets, retries, and view-only peer transcripts;
5. then group chat through the `G1`-`G4` deterministic-room sequence in `15-agent-group-chat-runtime.md`;
6. then richer `SendMessage` delivery types;
7. add `ReactToMessage` on the same host-bound message identity and audit path.

Exit check: all agent-communication acceptance criteria in `12-agent-communication.md` and group-chat criteria in `15-agent-group-chat-runtime.md` pass without experimental Codex dynamic tools, forged sender identity, synchronous reply polling, automatic publication of internal agent text, or unbounded bot loops.

## Phase 9: post-v0 plugin foundation

Begin only after the Phase 6 v0 release gate is green. Deliver in the sequence defined by `11-plugin-architecture-research.md`:

1. skills-only Agent Plugins with manifest validation, immutable installs, and per-bot enablement;
2. a curated remote MCP connector through an OpenBot policy gateway;
3. OAuth with an encrypted credential vault, multiple account aliases, and bot-specific connection grants;
4. per-tool approvals, redacted audit, revocation, restart, and tamper tests;
5. only then, trusted local stdio connectors, compatibility importers, and a broader marketplace.
6. expose filtered `GetDynamicTools` and re-authorized `CallDynamicTool` only after the effective catalog and policy gateway are proven; prefer direct typed MCP calls for manageable catalogs.

Exit check: all connector milestone acceptance criteria in `11-plugin-architecture-research.md` pass without calling Codex app-server plugin methods marked under development or depending on experimental dynamic tools.

## Native-tool workstream across phases

`13-native-tool-surface.md` is a cross-cutting workstream rather than a new all-at-once phase:

1. v0 covers the `Shell` and `Read` capability classes through Codex.
2. Phase 7 adds `Screenshot` through the real bot-screen manager.
3. Phase 8 adds explicit `SendMessage` and `ReactToMessage` alongside `SendToAgent`.
4. Phase 9 adds effective-catalog discovery and dynamic dispatch for plugins/connectors.
5. Later memory/routine work implements typed state commands before a compatible `update_state` facade.
6. The enrolled host-bridge milestone adds `ExternalRead`, then `ExternalShell`; both remain absent before that boundary is ready.

This plan targets capability coverage, not ten duplicate tool implementations. The omitted routine-trigger union is intentionally deferred until provider-specific triggers, webhook verification, connection references, and replay semantics exist.

## Test strategy

### Unit tests

- shared-workspace path normalization and computer-boundary containment;
- domain transitions for run and approval status;
- protocol-to-domain event mapping;
- idempotency hash and replay behavior;
- configuration redaction;
- reducer behavior for provisional versus completed items.
- exhaustive OpenBot run-item-to-view mapping and duplicate suppression.
- Markdown/link/tool-output sanitization and unsafe protocol rejection.
- post-v0 peer priority ordering, chain budgets, group-round ordering, silent completion, and output reconciliation.

### Integration tests

- Prisma repositories against temporary PostgreSQL;
- migrations up from an empty database;
- fake app-server JSONL protocol lifecycle;
- AI Elements core rendering under Electron/Vite production settings without `next` installed;
- server API plus SSE ordering/replay;
- child-process crash and restart;
- volume-backed workspace behavior.
- native-tool ownership tests proving shell/read cannot bypass Codex policy and dynamic calls cannot bypass per-tool policy.
- screen lease and one-computer-task-per-bot transitions.
- post-v0 transactional peer enqueue, delivery leases, crash recovery, and forged-sender rejection.

### End-to-end tests

- Electron creates a bot and receives a streamed response;
- packaged Electron exercises conversation anchoring, inspector collapse, dark/reduced-motion modes, and keyboard navigation;
- approval accept and decline;
- cancellation;
- Electron restart;
- server restart;
- full Compose recreation with retained volumes;
- cross-bot file handoff on the shared workspace;
- post-v0 separate bot-screen state with shared browser-session behavior.
- post-v0 screenshot provenance and attachment/artifact normalization.
- post-v0 Bot A → Bot B → Bot A asynchronous reply and priority-interruption flows.

### Manual checks

- macOS window behavior, sleep/wake, and offline recovery;
- keyboard navigation and screen-reader announcements;
- long transcript performance;
- missing/invalid upstream credential messaging;
- Docker-not-running experience.

## First implementation PR-sized slices

1. Monorepo skeleton, checks, and architecture README.
2. Prisma models, migrations, and Compose Postgres.
3. Codex protocol generation and fake transport.
4. Real app-server supervisor spike under Bun.
5. Bot/shared-computer CRUD and organizational folders.
6. Conversation/run/event API.
7. Minimal Electron rail, AI Elements transcript/composer/activity adapter, and headless computer inspector.
8. Approval and activity UI.
9. Restart/recovery hardening.
10. Self-hosting and backup documentation.

First post-v0 slices:

11. Graphical computer image with Chrome, Thunar, and terminal.
12. Bot-screen manager plus stream/takeover spike.

Do not start plugins, routines, voice, semantic memory, remote hosts, or native computer control until the restart acceptance suite is green.
