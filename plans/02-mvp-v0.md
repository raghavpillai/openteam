# MVP v0

> Implementation update (2026-08-24): the original headless baseline below has been surpassed by the real graphical-computer slice in `20-graphical-computer-implementation.md`. Headless exclusions in this document record the original release cut, not current product capability.

Status: canonical release scope  
Last updated: 2026-08-24

## Product promise

On one self-hosted machine, a user can create named bots, send them messages, let bots exchange durable direct messages or participate in ordered group rooms, watch Codex work, close the desktop app, reopen it, and continue the same per-bot threads on one shared persistent headless computer.

That restart-safe vertical slice is v0. It proves the durable product loop before OpenBot takes on the much harder graphical-desktop, multi-agent, plugin, routine, or memory problems.

The canonical milestone sequence and release checklist are in `16-v0-release-plan.md`.

## Release shape

v0 is deliberately one complete loop rather than a partial clone of every Grok Bot surface:

```text
create bot
  -> send text message
  -> Codex works in the shared /workspace
  -> stream messages and activity
  -> approve, decline, or cancel
  -> close/restart everything
  -> reopen the same bot, chat, thread, and files
```

The Electron window has three panes: a bot rail, an AI Elements conversation, and an activity inspector. The inspector reports the real headless computer and recent work. It does not show a decorative or simulated desktop.

## In scope

### Bots

- List bots in a left rail.
- Create a bot with a name, optional icon/color, and short instructions.
- Give every bot access to the installation's shared persistent computer and `/workspace`.
- Assign each bot a default project folder for organization, without presenting it as a security boundary.
- Rename, edit instructions, and archive a bot.
- Remember the last-opened bot locally.

### Conversations

- Create one durable empty default conversation with the bot; create its Codex thread lazily on the first message.
- Render the Electron conversation with the selected AI Elements primitives through an OpenBot run-item adapter; AI Elements is not a second runtime or persistence model.
- Persist user and agent messages.
- Stream agent text while a turn is running.
- Render command, file-change, and approval items in a compact activity presentation.
- Cancel an active turn.
- Resume the same Codex thread after server and desktop restarts.
- Keep the database model ready for multiple conversations per bot, even if v0 exposes only the default conversation.

### Runtime and computer

- Run Codex in the always-on Compose stack.
- Use Codex's native model-facing shell and file tools on the shared OpenBot computer; do not introduce duplicate unrestricted wrappers.
- Execute inside the shared computer, normally from the selected bot's default project folder, using a conservative computer-wide sandbox.
- Keep the shared computer home/workspace and Codex thread state on named volumes.
- Show runtime online/offline state, shared-computer identity, active turn, and recent tool activity in the right inspector.
- Prompt for actions that cross the configured safety boundary.

### Operations

- Start Postgres and the OpenBot server/runtime with one Compose file.
- Expose health checks.
- Bind the unauthenticated v0 server to localhost by default.
- Recover cleanly from an app-server child-process restart.
- Include a repeatable database migration and seed path.

## Explicitly out of scope

- OpenBot login, signup, sessions, permissions, organizations, or sharing;
- public internet exposure or cloud deployment;
- native control of the user's physical desktop;
- remote runtime hosts;
- routines, cron scheduling, and proactive messages;
- plugins, a plugin marketplace, and connector OAuth;
- long-term semantic memory across conversations;
- retrieval/vector databases;
- attachments, voice, and images;
- a graphical Linux desktop, Chrome/Chromium, Thunar, per-bot screens, screen streaming, or human takeover; these are the first post-v0 computer-parity milestone, not a different filesystem model;
- branching/forking UI;
- mobile and browser clients;
- auto-update, code signing, notarization, and Windows/Linux packaging.

The post-v0 plugin direction is nevertheless fixed in `11-plugin-architecture-research.md` so v0 does not accidentally couple plugin state to a conversation, browser profile, or experimental Codex API.

Direct agent messages, group channels, and peer wake scheduling are implemented as described in `12-agent-communication.md`, `15-agent-group-chat-runtime.md`, and `19-agent-interaction-implementation.md`.

The native-tool ownership model is fixed in `13-native-tool-surface.md`. v0 proves the Codex-owned `Shell`/`Read` equivalents. The graphical-computer milestone adds `Screenshot`; rich `SendMessage`, reactions, state mutation, dynamic plugin dispatch, and physical-host tools remain staged work rather than MVP scope expansion.

The Electron/AI Elements renderer boundary is fixed in `14-electron-ai-elements-ui.md`. v0 includes the compatibility gate, text conversation, tool/command activity, approvals, composer, bot rail, and inspector. Attachment, voice, channel, plugin, and routine components are installed or exposed only when their matching product capability exists.

## Core user stories

### Create a bot

1. The user clicks `+` in the left rail.
2. The form asks for name and instructions; icon/color are optional.
3. The server creates the bot plus its empty default conversation and provisions a default folder inside the shared `/workspace`.
4. The bot appears in the left rail and opens an empty conversation.
5. No Codex thread is created until the first message, avoiding empty upstream state.

### Send the first message

1. The desktop posts the message with an idempotency key.
2. The server persists the user message and creates a turn record.
3. The runtime supervisor ensures `codex app-server` is initialized.
4. The server starts a Codex thread with the bot's default working directory on the shared computer and the computer safety policy.
5. The returned Codex thread ID is committed to the conversation.
6. The turn starts; deltas and activity flow to the desktop.
7. Authoritative completed items are persisted, followed by the final turn status.

### Continue after restart

1. The user closes Electron; the Compose services continue running.
2. The user reopens Electron and selects the bot.
3. The server returns persisted conversation messages and current run state.
4. On the next message, the runtime calls `thread/resume` with the stored Codex thread ID.
5. The answer reflects the existing bot-specific Codex thread and the files on the same shared computer.

### Approve an action

1. Codex requests approval for a command or file change.
2. The server persists a pending approval and streams it to the desktop.
3. The user accepts or declines.
4. The desktop submits the decision by approval ID.
5. The server resolves the matching app-server request and persists the outcome.

## Context and memory behavior

- Conversation continuity comes from the bot-specific native Codex thread plus the shared persistent computer.
- OpenBot renders Codex context-compaction events but does not write a second automatic summary in v0.
- Postgres stores the product transcript for fast rendering and recovery; it is not treated as a drop-in replacement for the native Codex rollout.
- Bot instructions apply to new conversations. Changing them does not silently rewrite old conversation history.
- There is no hidden cross-conversation personal memory in v0.

## Acceptance criteria

The MVP is accepted when all of the following pass:

1. A clean checkout can start the headless stack with `docker compose up --build` after the operator supplies the documented upstream credential.
2. The desktop can create two bots with separate names, instructions, and conversation histories on the same computer.
3. Each bot can complete a streamed Codex turn.
4. A file created by one bot in `/workspace` remains after restarting Electron, the computer/server containers, and Postgres, and the other bot can intentionally read and continue that work.
5. Both conversations remain readable after restart, and each can successfully continue through `thread/resume`.
6. A pending command or file approval is visible and can be accepted or declined without mismatching another conversation.
7. If the app-server child process dies, the supervisor restarts it and the next turn resumes the stored thread.
8. Duplicate message submission with the same idempotency key does not create two turns.
9. An active turn can be cancelled and reaches a durable terminal state.
10. The default network binding does not expose the unauthenticated API beyond the local machine.
11. A packaged Electron build renders the pinned AI Elements conversation/tool/approval stack under the production CSP with no Next.js, no renderer model credential, and correct snapshot-plus-SSE replay.
12. The activity inspector never claims a live graphical screen, Chrome session, Thunar session, routine, plugin, memory, or host-computer capability that v0 does not implement.
13. `SendToAgent` creates one duplicate-safe, asynchronous recipient wake and returns without polling for a reply.
14. A user group post produces one durable round whose member deliveries execute in stable configured order; later members see earlier visible replies and every member may remain silent.
15. Bot-private user DMs do not appear in another bot's transcript; only the explicit peer message crosses that boundary.

## Definition of "done" for the planning phase

- The numbered plan files agree on the same v0 boundary.
- Architecture decisions required to scaffold the repository are recorded.
- Deferred features are clearly separated from the vertical slice.
- Remaining questions can be answered during implementation without changing the product's core direction.
