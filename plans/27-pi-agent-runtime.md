# Pi agent runtime

Status: implemented for MVP v0  
Last updated: 2026-08-25

## Decision

OpenBot embeds Pi's TypeScript SDK in the always-on computer service and creates exactly one durable Pi session per bot. Pi uses its `openai-codex` OAuth provider for model access. The previous Codex app-server adapter is no longer in the live execution path.

This is deliberately **one session per bot**, not one session per visible conversation, group, or screen. A bot's DM, agent-to-agent deliveries, ordered group turns, first-start wake, and later routines are addressed inputs into the same continuing session.

## Why Pi is the better v0 host

Confirmed from Pi's source and SDK documentation:

- `createAgentSession` is a direct TypeScript embedding API; OpenBot does not need to manage a separate JSON-RPC child protocol.
- `SessionManager` creates and reopens append-only JSONL session trees with stable IDs and branching metadata.
- `AgentSession` streams lifecycle, message, tool, retry, and compaction events.
- custom tools are ordinary typed definitions, so OpenBot controls their schemas and execution identity.
- compaction is built in, automatic, manually callable, and stored in the session tree.
- the `openai-codex` provider supports OAuth credentials and refresh.

The product-level advantage is not just fewer lines. Pi lets OpenBot own the semantics that matter—mailboxes, addressing, group rounds, visible delivery, GUI identity, and session placement—without also owning a guessed model-history array or an app-server compatibility layer.

## State ownership

| State                                               | Authority            | Reason                                         |
| --------------------------------------------------- | -------------------- | ---------------------------------------------- |
| bot identity, instructions, runtime session ID/path | PostgreSQL           | inspectable product state and recovery mapping |
| pending wakes, leases, priority, retry              | PostgreSQL + pg-boss | durable actor mailbox                          |
| visible DM/group/peer messages                      | PostgreSQL           | UI, audit, and delivery source of truth        |
| model-visible history and compaction tree           | Pi JSONL session     | native model context continuity                |
| files and projects                                  | `/workspace` volume  | shared computer filesystem                     |
| editable profile/settings/memory/skill/routine projections | agent-data volume | filesystem compatibility and hand edits |
| OAuth and computer app state                        | computer-home volume | never exposed to Electron or Postgres          |

The four backup units are PostgreSQL, `openbot_computer_home`, `openbot_agent_data`, and `openbot_workspace`. A backup missing any one of them is not a complete continuity backup. PostgreSQL can regenerate normalized agent-data projections, but the agent-data volume is required to retain unreconciled hand edits and safe transcript mirrors.

## Session identity

The `Bot` row stores:

```text
runtimeProvider    = "pi"
runtimeSessionId  = stable Pi session id
runtimeSessionPath = /home/openbot/.pi/agent/sessions/openbot/<file>.jsonl
```

The first bot wake creates the session with the bot UUID as the requested session ID. The computer emits `session.attached`; the worker projection persists the ID and canonical path. Every later wake supplies that stored path and Pi reopens it.

`Conversation` remains the home-DM UI projection for compatibility with the product model. Legacy `codexThreadId` fields are not read or written by the Pi runtime and may be removed in a later destructive cleanup migration.

The path is validated under the configured Pi sessions directory and must be a JSONL file. A runtime cannot silently replace an attached bot session or provider.

## Wake flow

```text
user / peer / group / bootstrap input
              │
              ▼
Postgres InboxEvent ── pg-boss wake hint
              │
              ▼
worker acquires bot-wide lease
              │
              ├── choose cwd (bot folder or group project)
              ├── build current platform instructions and address catalog
              └── send sessionPath + addressed content
                          │
                          ▼
computer opens the same Pi session with this turn's cwd
                          │
                          ▼
Pi prompt → tools/events → NDJSON projection → Postgres/SSE
```

At most one turn executes for a bot across all origins. Closing Electron has no effect. If the client, server, worker, or computer restarts, the durable mailbox and session file remain.

Changing the cwd for a group wake does not create another session. It changes the working directory for that invocation so Pi's read/bash/edit/write tools operate in the group project while the bot retains its full prior context.

## Group and peer behavior

OpenBot—not Pi—owns addressing and ordering:

- `SendToAgent` durably inserts a peer or group delivery and immediately acknowledges it.
- the recipient wakes later on its own bot session; the sender does not poll for a reply.
- one group round visits members in deterministic order.
- each later group member receives the new room delta, including earlier same-round visible sends.
- visible output requires `SendMessage`; unsent assistant text remains run activity rather than a forged room message.
- private bot sessions are never shared. A bot can refer to its own private context in a group, but cannot read another bot's JSONL session.

## Tools

Pi supplies `read`, `bash`, `edit`, and `write` inside the isolated computer container. OpenBot registers:

- `SendMessage`: visible text, attachment, widget, cursor-agent, or secret-request delivery through the server policy boundary;
- `SendToAgent`: fire-and-forget bot/group messaging with optional one-to-one priority interruption;
- `Screenshot`: returns the active bot display as an image;
- `Computer`: structured mouse, keyboard, scroll, wait, and app-launch actions followed by a fresh screenshot.

Specialized background workers narrow that normal catalog further. `computerUse` receives only `Shell`, `Read`, and a direct `Computer` tool with screenshot, click, move, drag, type, key, scroll, wait, and up to nine safely batched follow-ups. `browserUse` receives only `Shell`, `Read`, and the 15 direct `browser_*` tools backed by a Node-hosted Playwright driver over the bot Chromium process's loopback CDP endpoint. Browser refs are per-tab snapshot leases and page-changing actions invalidate them.

The model never supplies sender identity, run ownership, or display identity. The computer binds each call to the active runtime record, and the server revalidates run/bot/channel/delivery state.

Pi extensions and prompt templates are disabled in v0 so an ambient computer-home extension cannot silently expand the tool surface. OpenBot can add reviewed plugin/MCP adaptation later.

## Event projection

Pi session events map to the existing product event stream:

- session attachment → immutable bot runtime association;
- assistant text deltas → streaming internal/visible projections;
- assistant completion → authoritative completed item;
- tool start/end → run item start/completion;
- compaction → quiet compaction item;
- automatic retry → retrying runtime error activity;
- abort/error/end → authoritative run completion.

Image bytes from tool results are not copied into Postgres JSON activity. The product records bounded metadata while Pi retains the native tool result in its session.

## Compaction

OpenBot configures Pi automatic compaction with an explicit reserve and recent-token budget. Manual compact reopens the same bot session and calls `AgentSession.compact()`.

Rules:

1. Pi is the only model-context compactor.
2. OpenBot never deletes visible chat or audit rows because a session compacted.
3. Durable memory is a separate future typed product feature; compaction is not cross-bot memory.
4. A bot cannot compact while it has an active turn.
5. Compaction entries remain in the append-only session tree and survive restarts.

## Authentication

Run:

```sh
bash scripts/compose.sh exec computer openbot-pi-login
```

The wrapper launches `pi-ai login openai-codex` from the configured agent directory. Browser and headless device-code flows are available. The resulting OAuth credential is written to the private computer-home volume and used by the embedded `ModelRuntime`; it is not stored in `.env`, Postgres, Electron, or logs.

The computer health payload exposes only provider/model/readiness/authenticated state. Missing auth leaves the product UI usable and reports `Pi missing`.

## Cancellation and approval boundary

Stop calls `AgentSession.abort()`. The worker's bot lease continues to serialize subsequent wakes.

Direct follow-up messages during a user run call Pi's steering queue with one-at-a-time delivery.
The Postgres inbox remains authoritative until the Pi stream confirms that the user message was
inserted. Any accepted but unconfirmed input is recovered as a normal queued run; successful
steering therefore has the responsiveness of one live agent loop without becoming in-memory-only.

Pi's file and shell tools run inside the non-root, capability-dropped, read-only-root computer container. There is no Codex app-server approval callback in this architecture. Human takeover and the screen input lease still gate graphical input. A future physical-host bridge or materially broader filesystem/network action needs its own explicit policy and approval surface.

## Model configuration

The v0 default is configured through:

```text
OPENBOT_PI_MODEL=gpt-5.5
OPENBOT_PI_THINKING=high
```

The computer verifies that Pi's `openai-codex` catalog contains the selected model before it reports runtime readiness. This is deployment configuration, not a Bot database field.

## Migration notes

- `Run.codexTurnId` became provider-neutral `runtimeTurnId`.
- `ComputerTurnRequest.threadId` became `sessionPath`.
- `thread.attached` became `session.attached` with provider, ID, path, and model.
- runtime status `codex` became `agent` in the client contract.
- Codex CLI, API-key entrypoint login, and the separate Codex home volume were removed from Compose.
- Pi auth and sessions now live in the existing computer-home volume.
- the generated `packages/codex-client` package remains only as unused migration history and is not imported by runtime code.

## Acceptance criteria

- [x] the monorepo type-checks with the Pi SDK and custom tool schemas;
- [x] the computer image ships Pi's SDK intact without a Codex app-server process;
- [x] every wake uses the bot-level session path;
- [x] DM and group cwd changes do not allocate new model sessions;
- [x] session attachment is immutable and persisted on `Bot`;
- [x] automatic and manual compaction use Pi;
- [x] Electron is a client only and reports provider-neutral agent health;
- [x] OAuth is operator-driven and never passes through Electron;
- [x] an authenticated Compose smoke completes two real model turns in one durable bot session.

The authenticated acceptance smoke created a bot, observed the exact onboarding `SendMessage`, sent a later direct message, observed the second exact `SendMessage`, and verified two completed runs. PostgreSQL retained one Pi session mapping for the bot, while its append-only JSONL contained one session header and both turns. A tool-only turn also produced no empty assistant projection.

## References

- [Pi monorepo](https://github.com/earendil-works/pi)
- [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- [Pi sessions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sessions.md)
- [Pi compaction](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md)
- [OpenAI Codex authentication](https://learn.chatgpt.com/docs/auth)
