# v0 implementation status

Status: implemented and verified  
Last updated: 2026-08-27

## Outcome

The v0 vertical slice in `16-v0-release-plan.md` and the graphical-computer slice are implemented. OpenBot can create durable bots, accept idempotent messages through per-bot Postgres mailboxes, run one Pi session per bot, project streamed work, exchange asynchronous agent messages, run ordered group rounds, survive service restarts, continue from the same native session and shared workspace, and operate independent Linux GUI desktops.

The Electron client is a real packaged application rather than a mockup. The Compose stack is a real, persistent runtime rather than a development-only topology.

## Shipped surface

- Bun/Turborepo/TypeScript workspace with Effect schemas and service boundaries;
- Prisma/PostgreSQL product state and first migration;
- pg-boss wake jobs, authoritative inbox records, per-bot leases, heartbeats, and boot recovery;
- pinned Pi SDK embedding with durable session create/resume, event streaming, steering, abort, automatic/manual compaction, and OpenAI Codex OAuth;
- authenticated private computer gateway, shared persistent `/workspace`, persistent computer home containing Pi sessions/OAuth, path containment, non-root execution, dropped capabilities, and no host Docker socket;
- stable per-bot Debian XFCE displays with Xvfb, XFWM, xfdesktop, XFCE Panel, Chromium, Thunar, XFCE Terminal, x11vnc/noVNC, PNG capture, structured xdotool input, human takeover leases, and agent-input pause;
- an exact ten-tool direct native catalog: `SendMessage`, `ReactToMessage`, `update_state`, `ExternalShell`, `ExternalRead`, `Shell`, `Read`, `Screenshot`, `GetDynamicTools`, and `CallDynamicTool`;
- bot-scoped `Screenshot` plus dynamically discovered `Computer`, resolved inside the active runtime instead of accepting a caller-supplied bot identity;
- OpenBot dynamic discovery and dispatch with per-turn discovery receipts, current-status checks, and nested argument validation; `openbot` exposes `Computer` and `SendToAgent`, and `cursor` exposes only the approved nine-tool todo/orchestration/administration subset;
- durable per-agent todos and parent-scoped hidden subagent actors with bounded concurrent execution, status inspection, safe transcript paths, live steering, stop, resume, and private completion wakes;
- specialized `computerUse` workers with a direct screenshot/pixel `Computer` surface, drag paths and bounded action batching, plus specialized `browserUse` workers with the complete 15-tool ref-driven Playwright/CDP browser surface and privileged-CDP restrictions;
- localhost API with bot CRUD, idempotent message acceptance, snapshot, conversation projection, approval, cancel, compact, health, and replayable SSE events;
- Electron/React/Tailwind desktop using source-owned AI Elements adaptations for messages, tools, conversation scrolling, and the composer;
- first-class bot-DM, agent-DM, and group channels backed by canonical visible `ChannelMessage` records;
- dynamic `SendMessage` and `SendToAgent` tools bound to the active bot/run/channel capability;
- native `update_state` with scheduled routine lifecycle plus explicit memory tiers/scopes, shared user memory, per-bot project shards, saved skills, profile/settings, connector disconnect gates, project membership/folders, avatar validation, prompt projection, idempotent host-call receipts, and audit events;
- PostgreSQL routine definitions/revisions/executions and a once-per-minute pg-boss dispatcher that returns scheduled work to the bot's existing mailbox and Pi session;
- idempotent user-message reactions, rendered from canonical message metadata;
- local `Shell`/`Read` implementations and a separate authenticated, per-call approval Electron bridge for physical-host `ExternalShell`/`ExternalRead`;
- fire-and-forget peer mail, priority interruption restricted to non-user work, duplicate-safe tool calls, and explicit reply wakes;
- durable group rounds with immutable per-member deliveries, stable member ordering, silence semantics, and restart recovery;
- persistent bot working folders and group-owned shared project folders, with group turns automatically rooted in the room project and explicit UI paths;
- encrypted computer-scoped browser-cookie synchronization across separate Chromium processes and profiles;
- bot rail, group creation, member/round inspector, search, create/edit/archive, light/dark theme, runtime inspector, live screen preview, fullscreen noVNC viewer, app launchers, takeover, agent-input pause, approval cards, activity projection, stop, manual compact, offline/degraded states, and missing-credential gating;
- one-command Compose startup, coordinated backup script, local packaging config, and operator documentation.
- bidirectional `/home/openbot/agent-data` projections for profile, settings, avatar pointers, Markdown memory, per-bot skills, and routine definitions, with valid hand-edit import and deterministic regeneration;
- shadcn-based Grok-reference renderer rewrite with expanded AI Elements composition, memoized snapshot projections, three-channel warm tab retention, lazy rich Markdown/code/diagram loading, coalesced non-overlapping snapshot refreshes, and durable close/reopen recovery.

## Verification evidence

The release was checked with:

1. `bun run format:check` over all owned source and configuration files;
2. `bun run check`, covering all seven workspaces' typechecks, tests, and production builds;
3. contract tests for validation and idempotent message inputs;
4. Pi session tests for durable JSONL create/resume, custom tool execution, streaming events, compaction, and immutable session attachment;
5. computer workspace path-containment tests;
6. a real PostgreSQL lifecycle integration test proving durable message acceptance, service restart, assistant projection, per-bot thread resumption, duplicate-safe agent DMs, private-transcript isolation, pending-round recovery, deterministic group order, and prior-reply visibility for later members;
7. a full `docker compose up --build -d` build and health smoke with named-volume persistence;
8. no-credential API/runtime smoke proving CRUD stays available, readiness is explicit, and model turns fail terminally rather than hanging;
9. a production renderer visual check at desktop dimensions;
10. an authenticated live agent smoke proving `SendToAgent` wakes a second bot on its own Pi session, carries the reply back asynchronously, and does not create a reply loop;
11. an authenticated two-member group smoke proving deterministic Alpha-then-Beta delivery, separate per-bot Pi sessions, round completion, and visibility of Alpha's committed room response in Beta's later wake;
12. a live graphical smoke proving two displays (`:100`/`:101`), two loopback noVNC viewers, Chromium navigation, Thunar, terminal input, immediate shared-file visibility, successful model-driven `Screenshot`/`Computer` calls, and takeover rejection of agent input;
13. an unsigned macOS arm64 DMG and ZIP package build.
14. a live shared-project smoke proving two bots retained different Pi session IDs, ran from the same persisted group directory, and immediately read each other's files;
15. a live browser-authority smoke proving cookie addition and deletion across separate Chromium profiles, encrypted durable-cookie recovery into a newly created bot after service restart, and removal of all temporary probe state.
16. a live renderer smoke proving an agent turn completes after the client closes, a new client restores the canonical reply, and recent bot switches preserve unsent per-bot drafts.
17. authenticated live `update_state` smokes proving exact-memory recall across turns, shared user-memory recall by a different bot, saved-skill projection, project provisioning through the computer service, avatar serving, duplicate-safe host calls, typed validation errors, and destructive actions for forget/delete/leave/clear.

## Operator prerequisite

OpenBot itself has no v0 authentication, but Pi's `openai-codex` provider still needs upstream OpenAI authentication. The operator runs `bash scripts/compose.sh exec computer openbot-pi-login`; the OAuth credential stays in the private computer-home volume. Without it, the API and desktop remain useful for bot configuration and durable history, while new model turns are disabled and direct turn requests are rejected before execution.

## Deliberately deferred

The following remain post-v0 work and are not represented by fake controls: synchronization of non-cookie browser storage and saved passwords, WebRTC/Xpra-class streaming optimization, plugins/MCP marketplace, live external connector adapters and event-triggered routines, routine inspector/test-run UI, secure secret requests, voice, full attachment normalization, interactive widget handling, and public deployment/auth.

The graphical implementation and its explicit limits are recorded in `20-graphical-computer-implementation.md` and `21-shared-workspaces-and-browser-authority.md`; the remaining architecture plans continue in `10-grok-computer-research.md` through `17-durable-agent-queue-and-screens.md`.
