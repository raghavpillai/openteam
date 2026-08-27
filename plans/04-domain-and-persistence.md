# Domain and persistence

Status: proposed for MVP v0  
Last updated: 2026-08-24

## Persistence goals

OpenBot must survive four independent events:

1. the Electron window closes;
2. the OpenBot server restarts;
3. the Codex app-server child process restarts;
4. the Compose stack is recreated while named volumes remain.

Postgres makes the product reconstructable. The Codex home volume makes native threads resumable. The shared computer home and workspace volumes preserve files and user-level runtime state across bots. Browser state and supported sign-ins begin using that same computer-scoped boundary only when the graphical milestone lands.

## Core records

The following is a conceptual Prisma model, not the final schema syntax.

### Bot

```text
id                    uuid
name                  text
slug                  text unique
icon                  jsonb nullable
instructions          text
status                active | archived
computerId            uuid
defaultWorkingDirectory text
defaultConversationId uuid
createdAt             timestamptz
updatedAt             timestamptz
archivedAt            timestamptz nullable
```

Bot instructions are versioned in product state and injected through the Codex runtime's supported thread configuration or initial context. A project `AGENTS.md` belongs to the shared project directory, not to one bot's persona. OpenBot must not overwrite an existing project instruction file merely because another bot enters that folder.

### Computer

```text
id              uuid
kind            compose_local
displayName     text
status          provisioning | online | offline | degraded | recovering
imageVersion    text
workspaceRoot   text
capabilities    jsonb
lastSeenAt      timestamptz nullable
createdAt       timestamptz
updatedAt       timestamptz
```

There is one `compose_local` computer in the no-auth v0. It is the shared filesystem, browser/login, CLI-credential, and application boundary for every bot. Keeping it explicit avoids incorrectly turning bots into security principals.

### Reserved post-v0 graphical record: BotScreen

```text
id                    uuid
computerId            uuid
botId                 uuid unique
status                stopped | starting | ready | busy | degraded
displayHandle         text nullable
activeComputerTaskId  text nullable
lastFrameAt           timestamptz nullable
lastSeenAt            timestamptz nullable
createdAt             timestamptz
updatedAt             timestamptz
```

A screen is not part of the first migration. When the graphical milestone lands, it becomes a bot-scoped work surface and concurrency lease, not a filesystem, cookie, credential, or OS-user boundary.

### Conversation

```text
id                   uuid
botId                uuid
title                text nullable
status               active | archived
continuityStatus     new | attached | detached
codexThreadId        text unique nullable
codexSessionId       text nullable
computerId           uuid
lastMessageAt        timestamptz nullable
createdAt            timestamptz
updatedAt            timestamptz
archivedAt           timestamptz nullable
```

The v0 home conversation has a unique constraint on `botId`: creating a bot creates its one home conversation, and that home maps to one Codex thread. Later direct/group channels are UI and delivery projections into the same bot thread, not additional runtime sessions.

`codexThreadId` is null and continuity is `new` until the first turn successfully starts. Once set, the thread association is immutable and continuity becomes `attached`. If native thread state is irrecoverably missing, the conversation remains readable but is marked `detached`; the user must explicitly start a replacement thread rather than OpenBot silently pretending continuity.

### Message

```text
id               uuid
conversationId   uuid
role             user | assistant | system
content          jsonb
status           pending | streaming | completed | failed | cancelled
clientMessageId  text nullable
sourceRunItemId  uuid nullable
createdAt        timestamptz
updatedAt        timestamptz
completedAt      timestamptz nullable
```

Use a unique constraint on `(conversationId, clientMessageId)` when `clientMessageId` is present. Text is the only v0 content part, but JSON leaves room for attachments without a migration that changes message identity.

### Run

```text
id                 uuid
conversationId     uuid
userMessageId      uuid
codexTurnId        text nullable
status             queued | running | waiting_approval | completed | failed | cancelled | interrupted
errorCode          text nullable
errorMessage       text nullable
startedAt          timestamptz nullable
completedAt        timestamptz nullable
createdAt          timestamptz
updatedAt          timestamptz
```

A partial unique index enforces at most one `queued`, `running`, or `waiting_approval` run per bot home thread. The first schema can express this through the bot's unique home conversation; later channel projections still serialize through the same bot lease.

### InboxEvent

```text
id                uuid
botId             uuid
sourceKind        user_dm | peer | group | routine | system
sourceAddress     text nullable
payload           jsonb
priority          integer
idempotencyKey    text unique
status            pending | leased | processing | handled | dead
availableAt       timestamptz
attempts          integer
leaseOwner        text nullable
leaseExpiresAt    timestamptz nullable
createdAt         timestamptz
handledAt         timestamptz nullable
```

This is the authoritative durable mailbox. A pg-boss `bot-wake` job contains only `botId` and may be deduplicated/coalesced without deleting an inbox event.

### BotRunLease

```text
botId             uuid primary key
runId             uuid nullable
ownerId           text
leaseExpiresAt    timestamptz
heartbeatAt       timestamptz
generation        bigint
```

The lease is the strict one-active-turn-per-bot guard. pg-boss singleton or stately keys reduce redundant work but are not a substitute for this domain invariant.

### OutboxDelivery

```text
id                uuid
sourceRunId       uuid
toolCallId        text nullable
destinationKind   user_channel | agent_inbox | connector
destinationId     text
payload           jsonb
idempotencyKey    text unique
status            pending | delivering | delivered | failed | dead
attempts          integer
availableAt       timestamptz
createdAt         timestamptz
deliveredAt       timestamptz nullable
```

`SendMessage`, `SendToAgent`, and future connector effects write the outbox transactionally before delivery. This prevents duplicate visible messages when a model tool call or worker is retried.

### RunItem

```text
id              uuid
runId           uuid
codexItemId     text nullable
kind            agent_message | reasoning_summary | command | file_change | tool | compaction | error
status          pending | running | completed | failed | declined
summary         text nullable
payload         jsonb
ordinal         integer
createdAt       timestamptz
updatedAt       timestamptz
completedAt     timestamptz nullable
```

Completed app-server items are authoritative. Deltas update a provisional item or message on a throttle; OpenBot does not insert one database row per token.

### Approval

```text
id                uuid
runId             uuid
runItemId         uuid nullable
kind              command | file_change | permission | user_input
status            pending | accepted | declined | cancelled | expired
requestPayload    jsonb
decisionPayload   jsonb nullable
requestedAt       timestamptz
resolvedAt        timestamptz nullable
```

The app-server request correlation ID is runtime-ephemeral and may be stored in a private payload for the active process, but it must never be mistaken for the durable OpenBot approval ID.

### Event

```text
sequence      bigserial primary key
topic         text
entityId      uuid nullable
schemaVersion integer
payload       jsonb
createdAt     timestamptz
```

Events support SSE replay and debugging. Apply a retention policy after v0. Never persist credentials, raw environment dumps, full hidden reasoning, or unredacted command environments.

### IdempotencyRecord

```text
scope          text
key            text
requestHash    text
response       jsonb nullable
status         processing | completed | failed
createdAt      timestamptz
expiresAt      timestamptz
primary key    (scope, key)
```

## Reserved post-v0 plugin records

Do not put plugin tables in the first migration. Preserve the following conceptual boundaries for the post-v0 design in `11-plugin-architecture-research.md`:

- marketplace source, immutable plugin release, install, and component records;
- connector definitions separate from authenticated connector connections;
- secret-free connection metadata with a `credentialRef` into an encrypted vault;
- bot-level plugin enablements and named connection grants;
- tool policy, OAuth transaction, and tool-invocation audit records.

Plugin installation and OAuth connection are separate lifecycles. A plugin can be installed with no connected account, one connector can have several account aliases, and uninstall must not silently revoke or delete credentials. No access token, refresh token, authorization verifier, or client secret belongs in an ordinary Prisma column.

## Reserved post-v0 agent communication records

The design in `12-agent-communication.md` adds:

- direct/group `AgentChannel` and membership records;
- immutable `AgentMessage` records with channel ordering and correlation provenance;
- one `AgentDelivery` per recipient, retained as authoritative peer-delivery state while pg-boss supplies coalesced recipient wakes;
- durable `GroupRound` and ordered `GroupRoundMember` baton records with trigger cutoffs, per-member cursors, silent completion, and output reconciliation;
- peer/group origins and correlation metadata attach to the v0 `InboxEvent` and `BotRunLease` infrastructure;
- `Run.origin`, source peer message, initiating bot, and supersession metadata;
- typed outbound `SendMessage` records for text, attachments, widgets, and secure requests.

The `SendToAgent` acknowledgement is emitted only after the message, recipient delivery rows or group round, sender projection, and product event commit atomically. Delivery processing is at-least-once with deduplicated enqueue; OpenBot does not claim exactly-once model execution or exactly-once external side effects. Group-specific records and constraints are in `15-agent-group-chat-runtime.md`.

## Reserved native-tool records

The staged design in `13-native-tool-surface.md` needs records only as their milestones land:

- immutable `Artifact` metadata with source kind, media type, size, checksum, storage reference, bot/conversation/run provenance, and sanitized display name; this begins with screenshots and later backs attachments/images;
- `MessageReaction` keyed by bot and target message so reaction replacement is idempotent;
- typed memory, routine, trigger, profile, skill, channel, and project records behind state commands rather than a generic JSON state table;
- a redacted `ToolInvocationAudit` with resolved namespace/tool/version, caller provenance, approval, outcome, and idempotency key;
- future `HostDevice`, capability grant, path grant, and bridge audit records for `ExternalRead`/`ExternalShell`.

Do not persist raw attachment bytes, OAuth tokens, requested secrets, or physical-host credentials in ordinary product rows. Artifact storage and the encrypted credential broker keep their own references and lifecycle. The effective dynamic tool catalog is computed from installs, connections, bot grants, and policy; a cache may accelerate it but cannot become the authorization source of truth.

## Transaction boundaries

### Create bot

1. Reserve the bot ID, empty default conversation, and default working directory in Postgres.
2. Provision the bot's organizational folder inside the shared `/workspace` idempotently.
3. Mark the bot active only after provisioning succeeds.

If folder provisioning fails, retain a failed provisioning record or roll back the database transaction. A default bot folder is not private: other bots may read it, and path validation protects the computer boundary rather than pretending bot-to-bot isolation.

### Start first turn

1. In one transaction, insert the user message, `InboxEvent`, queued run, idempotency record, product event, and pg-boss `bot-wake` through its Prisma transaction adapter.
2. The wake worker acquires the bot run lease.
3. Outside the transaction, start the Codex thread when the bot has no attached home thread, or use the already loaded/resumed thread.
4. Persist the returned thread/session IDs before starting the turn.
5. Persist `codexTurnId` as soon as it is known.

If the process crashes between steps, a recovery worker can determine whether the conversation owns a native thread. OpenBot must not create a second thread merely because an HTTP request was retried.

### Complete run item

Persist the authoritative completed run item and any transcript projection in one transaction, then append the outward-facing event. A late delta cannot overwrite a completed item.

## Startup recovery

On server boot:

1. acquire a database advisory lock so only one v0 runtime supervisor becomes active;
2. migrate the database;
3. start pg-boss, validate its schema, and reclaim expired inbox/run/outbox leases;
4. validate the shared workspace root and every bot default directory against the configured computer volumes;
5. start/reconnect the shared computer, initialize app-server, and resume active bot home threads;
6. mark abandoned `running` or `waiting_approval` runs as `interrupted` unless app-server can prove they are still active;
7. expire approvals whose runtime request no longer exists;
8. keep their conversations resumable for the next turn;
9. enqueue wakes for pending inbox events that lack an eligible wake job;
10. emit recovery events so connected clients converge on the durable state.

v0 does not attempt exactly-once model execution across a hard crash. It provides exactly-once product command acceptance and explicit terminal recovery state.

## Source-of-truth rules

- Bot settings, UI transcript, run status, and approvals: Postgres.
- Model-visible conversation history and native compaction: Codex rollout referenced by `codexThreadId`.
- Files and durable working artifacts: the shared computer `/workspace` volume, visible to every bot.
- Future browser profile, supported sign-ins, and computer-level preferences: shared computer home volume.
- Post-v0 bot screen lifecycle: Postgres projection plus the live computer/session manager.
- Active stream deltas: memory plus throttled Postgres snapshots until a completed item arrives.
- Upstream credential: deployment secret/Codex credential store, never a Prisma model.

## Backup and restore

A valid backup contains a mutually consistent snapshot of:

- the PostgreSQL database;
- the Codex home/session volume;
- the shared computer home volume;
- the editable agent-data projection volume;
- the shared `/workspace` volume;
- the pinned OpenBot and Codex versions.

Document a maintenance-mode backup first. Online coordinated snapshots can wait. A database-only restore may render chats but cannot guarantee native thread continuation; a workspace-only restore preserves shared files but loses product organization; omitting the computer home may discard browser sessions and supported sign-ins.
