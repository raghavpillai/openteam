# OpenBot planning index

Status: MVP v0 implemented  
Last updated: 2026-09-01

## Goal

OpenBot is a self-hostable, desktop-first bot workspace inspired by the supplied Grok UI. A user can create bots, keep durable conversations with each bot, and let them work on one shared always-on computer. Pi is the agent host and uses OpenAI Codex OAuth/model access.

This plan set defines v0 and records the implementation that now ships in this repository.

## How future agents should read this plan set

Start with `30-canonical-context-handoff.md`. It records the current architecture, the evidence/instruction boundary, attachment provenance, and the precedence rules for resolving contradictions. Then read the feature document that owns the subsystem being changed and verify every claim against code, migrations, tests, and the live Compose stack.

The numbered files preserve research and design history; a lower number is not automatically more authoritative. In particular, Codex app-server plans are historical after the implemented Pi migration in `27-pi-agent-runtime.md`.

## Decisions made for v0

1. The product has one implicit local user. There is no OpenBot account, login page, team, or authorization model.
2. OpenAI still requires upstream authentication. The operator completes Pi's `openai-codex` OAuth flow outside Electron; the credential stays in the private computer-home volume.
3. A bot is a durable actor: identity, instructions, exactly one Pi JSONL session, one Postgres inbox, and an association to the shared OpenBot computer. DM, room, peer, bootstrap, and later routine wakes append to that same session rather than creating model sessions per UI surface.
4. The always-on computer is a graphical, user/installation-scoped Linux environment: bots share its filesystem while keeping separate conversations and separate virtual displays. Physical-host access is a distinct Electron bridge that requires a native approval for each read or command. Browser profiles remain separately writable for Chromium safety, while live origin state, stopped native profile state, client certificates, recovery, and owned-tab routing are computer-scoped.
5. The Electron app is a native client. Docker Compose owns the server, shared Linux computer/runtime, Postgres database, and persistent volumes. Electron itself is not a Compose service; the bot computer's remote graphical desktop can be.
6. OpenBot embeds Pi through its TypeScript `AgentSession` API inside the computer service. It does not shell out to the Pi TUI or reconstruct a chat messages array in the worker.
7. Postgres stores OpenBot product state and the UI/audit projection. Pi's append-only JSONL session tree lives under the persistent computer home; `/workspace` is a separate volume. Postgres, computer home, and workspace must be backed up together.
8. v0 uses Pi's native context/session tree and automatic compaction. Explicit curated durable state is a separate typed product layer; it does not replace compaction or dump transcripts into memory.
9. The direct Pi catalog is exactly the ten native tools in `packages/contracts/src/native-tools.json`: `SendMessage`, `ReactToMessage`, `update_state`, `ExternalShell`, `ExternalRead`, `Shell`, `Read`, `Screenshot`, `GetDynamicTools`, and `CallDynamicTool`. `Computer` and `SendToAgent` live in the first-party `openbot` dynamic namespace. The `cursor` namespace contains only the nine explicitly supported definitions in `packages/contracts/src/cursor-tools.json`: todo writing, four parent-owned subagent operations, two agent-administration operations, and two channel-administration operations. The runtime binds every call to the active bot/run so the model cannot forge sender identity, mutate another bot's state, or control another bot's display.
10. The model is deployment configuration, not a hard-coded product decision.
11. The native client is Electron. Its React 19 renderer uses Tailwind CSS 4, shadcn/ui, and source-owned AI Elements components for conversation and activity while OpenBot owns the desktop shell and SSE adapter. Electron has no direct model or Pi connection.
12. Postgres remains the durable mailbox source of truth. pg-boss supplies transactional wake jobs, retries, heartbeats, scheduling, and dead letters without adding Redis; queue execution never replaces OpenBot's domain inbox/outbox records.

## Plan set

- `01-product-context.md`: user request, screenshot observations, and interpretation boundaries.
- `03-system-architecture.md`: monorepo, process boundaries, Compose topology, and runtime flow.
- `04-domain-and-persistence.md`: domain model, Prisma-oriented schema, lifecycle rules, and backups.
- `05-codex-runtime.md`: superseded record of the original app-server decision.
- `06-always-on-computer.md`: persistent workspace design and the later native-computer bridge.
- `07-desktop-experience.md`: the Grok-inspired Electron experience without cloning brand assets.
- `10-grok-computer-research.md`: confirmed Grok shared-computer behavior, UI evidence, and the resulting OpenBot model.
- `11-plugin-architecture-research.md`: Grok/Claude/Codex/MCP comparison and the selected post-v0 plugin, connector, account, and policy architecture.
- `12-agent-communication.md`: durable bot mailboxes, direct/group channels, wake scheduling, priority, exact observed tool schemas, and Codex integration.
- `13-native-tool-surface.md`: coverage and ownership for the ten observed native tools, safe dynamic dispatch, rich delivery, state mutation, screenshots, and the future physical-host bridge.
- `14-electron-ai-elements-ui.md`: Electron renderer boundary, AI Elements compatibility gate and component map, OpenBot-owned shell/screen surfaces, performance, security, and UI delivery slices.
- `15-agent-group-chat-runtime.md`: Grok group-chat evidence, deterministic bot baton rounds, wake envelopes, per-member cursors, silence semantics, and Codex context mapping.
- `17-durable-agent-queue-and-screens.md`: pg-boss wake architecture, durable Pi sessions, delivery guarantees, and the shared-computer/bot-screen implementation direction.
- `18-v0-implementation-status.md`: shipped scope, verification evidence, operator prerequisites, and intentionally deferred work.
- `19-agent-interaction-implementation.md`: the implemented direct-agent and ordered-group runtime, exact tool contracts, delivery invariants, API/UI surface, and validation evidence.
- `20-graphical-computer-implementation.md`: the implemented per-bot Linux desktops, screen/input API, Electron viewer, safety boundary, live validation, and remaining browser-session work.
- `21-shared-workspaces-and-browser-authority.md`: implemented bot/group folder semantics, group-turn cwd routing, separate browser UIs with full computer-scoped browser authority, owned-tab routing, recovery, limits, and validation.
- `22-grok-parity-and-client-performance.md`: the shadcn/AI Elements rewrite, Grok-reference parity, warm bot tabs, lazy rich rendering, lightweight reconnect behavior, and live close/reopen validation.
- `23-interactive-desktop-and-qa.md`: click-to-control noVNC behavior, lease cleanup, restart/background-run validation, full v0 QA evidence, and the bugs fixed during that pass.
- `24-performance-optimization.md`: renderer request-loop diagnosis, client snapshot projection, stable React identities, warm inspectors, lazy rich rendering, local performance instrumentation, measured budgets, and production profiling evidence.
- `26-new-bot-onboarding-implementation-plan.md`: non-blocking durable creation, pg-boss provisioning, exactly-once bootstrap semantics, Grok-like inspector settings, safe transcript mirroring, performance budgets, delivery slices, and acceptance tests.
- `27-pi-agent-runtime.md`: the implemented migration to one durable Pi session per bot, OpenAI Codex OAuth, compaction, tools, event projection, persistence, and operational boundaries.
- `28-scheduled-routines.md`: the implemented schedule-only routine backend, Postgres-owned next-run state, pg-boss dispatcher, routine lifecycle, `update_state` slice, and deferred inspector UX.
- `29-update-state-manifest.md`: the full supplied compatibility reference plus the implemented schedule-routine and durable-state boundary, validation rules, persistence, and ownership.
- `30-canonical-context-handoff.md`: the canonical current-state handoff, document precedence, shipped feature map, artifact ledger/checksums, attachment inventory, and deferred scope.
- `31-agent-transcript-archive-findings.md`: forensic analysis of the supplied Grok agent transcript archive, including record counts, wake shapes, tool-use frequencies, confidence levels, and OpenBot implications.
- `32-agent-data-filesystem-parity.md`: implemented file-native profile, settings, memory, skills, routines, avatars, prompt snapshots, and lifecycle parity, plus the remaining source-incomplete edges.
- `33-grok-context-compaction-parity.md`: proposed replacement of Pi-default compaction with Grok-style background SelfSummarizer semantics, per-transcript scope, restart-safe archives, reconciliation, byte GC, and a full validation gate.
- `34-ios-mobile-parity.md`: evidence-graded Grok Bot iPhone research, live-capture protocol, screen and interaction specification, React Native reuse boundary, security constraints, delivery slices, and parity acceptance gates.
- `38-ios-performance-and-parity-audit.md`: source, bundle, dependency, sync, cache, upload, list, search, computer, authentication, and API-scale audit with measured remediation.
- `39-ios-native-simulator-validation.md`: signed Release simulator build/install, native Computer Use coverage, long-chat A/B, CPU/network/footprint evidence, final gates, and physical-device release gaps.
- `40-desktop-performance-reaudit.md`: completed dependency, Electron-main, renderer, search, realistic-workload, and 1,100-chat stress re-audit with before/after fixes, packaged smoke, CUA parity, and residual bottlenecks.
- `41-message-pagination-performance-data.md`: current source audit, deterministic policy comparison, live keyset/API measurements, Electron history-retention observation, pagination trade-offs, and the gated bounded-window recommendation.

## Vocabulary

- **Bot**: durable OpenBot configuration: name, icon, instructions, defaults, and conversations.
- **Home conversation**: the bot's persistent user-facing DM projection; it is one address into the bot's single Pi session, not the session itself.
- **Turn**: one user request plus the agent work that follows.
- **Run item**: a message, command, file change, approval, or other unit emitted during a turn.
- **Runtime host**: the computer service where Pi, OpenAI Codex model calls, and the shared Linux computer execute.
- **Bot computer**: the persistent computer shared by all bots in the installation; bot screens are work surfaces, not security boundaries.
- **Host bridge**: the authenticated, per-call approval bridge in the native desktop that lets `ExternalRead` and `ExternalShell` request work on the user's physical computer.
- **Plugin**: an installed, versioned package containing skills, connector definitions, or later host-specific components.
- **Connector**: an external capability provider, normally exposed through MCP.
- **Connection**: one authenticated account instance of a connector, such as `gmail:work`.
- **Agent channel**: a durable direct or group transcript shared by participating bots and inspectable by the user.
- **Peer message**: a fire-and-forget message that durably queues a later recipient wake; a reply is a new message, not a tool return value.
- **Inbox event**: an immutable durable wake payload for one bot; pg-boss schedules its processing but is not its source of truth.
- **Bot screen**: a bot-scoped graphical work surface on the shared computer; it does not isolate files, CLI credentials, or browser state. Chromium profiles are separately writable while live origin state, stopped native-profile state, and client certificates use computer-scoped authorities.
- **Group round**: one durable, ordered pass over the eligible bots in a group after room activity; every member receives a separate turn and may respond once or stay silent.
- **Native tool**: a first-party capability supplied by Pi, the OpenBot control plane, the computer service, or the native host bridge rather than an installable third-party plugin.
- **Tool gateway**: the OpenBot policy boundary that computes a bot's effective catalog, validates calls, requests approvals, dispatches to first-party or MCP backends, and records redacted audit events.
- **Artifact**: an immutable, provenance-bearing file or image record normalized from a safe local or remote source before it is shown to the user or passed between tools.

## Authoritative runtime references

- [Pi monorepo](https://github.com/earendil-works/pi)
- [Pi SDK guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- [Pi sessions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sessions.md)
- [Pi compaction](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md)
- [OpenAI Codex authentication](https://learn.chatgpt.com/docs/auth)

These references were checked on 2026-08-25. The Pi packages are pinned because the embedding and session APIs are versioned implementation dependencies.

## Authoritative UI references

- [AI Elements](https://elements.ai-sdk.dev/)
- [Official Vercel AI Elements repository](https://github.com/vercel/ai-elements)

These references were checked on 2026-08-24. Copied component source and its upstream version/revision must be committed and reviewed like application code.
