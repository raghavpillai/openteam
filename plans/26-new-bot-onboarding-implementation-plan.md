# New-bot onboarding implementation plan

Status: implemented and validated  
Last updated: 2026-08-25

## Goal

Make a new OpenBot bot feel alive immediately:

- creation requires no up-front configuration;
- the bot and its DM appear as soon as their durable records commit;
- the computer visibly moves through `starting → ready` in the background;
- the bot sends a short, proactive, profile-aware opening without a fake user bubble;
- Name, Title, Description, and Notifications live in a Grok-like inspector settings pane;
- the same bot identity owns one durable Pi session, mailbox, computer display, browser profile, transcript mirror, and profile for its lifetime;
- all server, worker, computer, and bot work continues when Electron is closed.

This plan implements the supplied onboarding evidence. It does not claim knowledge of Grok's private system prompt or exact internal protocol.

## Implementation outcome

The v0 slice described here is now implemented across the database, contracts,
server, durable worker, computer service, and Electron client.

Shipped behavior:

- `POST /api/v0/bots` is idempotent through `clientRequestId`, commits the Bot,
  home Conversation, bot DM, event, and transactional `bot-provision` pg-boss
  job, then returns the `provisioning` BotView without waiting for the computer;
- the worker provisions the shared workspace and bot-scoped Linux display,
  promotes the same bot to `active`, retries failures, recovers missing durable
  work on restart, and exposes retry state rather than creating replacement
  identities;
- onboarding has a separate persisted state machine and exactly-once bootstrap
  key. The hidden bootstrap is an internal `system` Message/Run/InboxEvent and
  visible output still comes only from `SendMessage`;
- a first real user message supersedes pending or in-flight bootstrap work. The
  canceled bootstrap cannot later resurrect its Run or overwrite
  `skipped_by_user` because both the worker and stream projection use guarded
  status transitions;
- the bot profile now persists Title, Description, Notifications, onboarding
  state, and redacted provisioning errors alongside the existing identity;
- the desktop uses the compact one-click `New Bot` flow, a temporary optimistic
  row, immediate selection, provisioning/onboarding activity, autosaving
  inspector settings, lifecycle-aware screen states, retry controls, and a
  shadcn context menu with read-only transcript access;
- the computer owns an atomic, private safe-transcript mirror at
  `/home/openbot/agent-data/agent-transcripts/<bot-id>/<bot-id>.jsonl`.
  It contains visible-message and run-summary projections only. Raw Pi
  rollouts, reasoning, prompts, approval payloads, credentials, and secrets are
  never mirrored.

Deliberate boundaries:

- OpenBot does not manufacture the unexplained Grok `.journal-mode` companion
  file without evidence of its semantics;
- Notifications is a durable preference in this slice, not an OS push service
  that can run after Electron itself is fully quit;
- model-driven profile mutation remains part of the broader `update_state`
  native-tool work. The v0 stores one canonical Bot profile so that future tool
  must write the same record rather than introduce a second memory/profile
  store.

### Validation evidence

- repository-wide `bun run typecheck`, `bun run test`, and `bun run build`
  complete successfully;
- a real isolated Postgres/pg-boss lifecycle test passes 33 assertions covering
  non-blocking creation, create idempotency, user-first bootstrap suppression,
  one proactive greeting, direct bot messaging, durable threads, and ordered
  group turns;
- the rebuilt Compose stack applied the migration and reports healthy server,
  worker, computer, and Postgres services;
- live API QA created one bot, observed the immediate `provisioning/pending`
  response, then the same identity becoming `active/completed` with one
  proactive `SendMessage`, a ready Linux display, and a safe JSONL mirror with
  private file permissions;
- replaying the same create key returned that same bot and did not add another
  record or greeting;
- browser-level visual QA verified plus menu → New Bot, default `New Bot`,
  `Customize first`, settings fields, live desktop preview, right-click bot
  actions, and the safe transcript dialog against the running stack.

## Baseline at plan authoring

OpenBot already has most of the hard primitives:

- `BotStatus` includes `provisioning`, `active`, `failed`, and `archived`;
- `createBot` transactionally creates a Bot, Conversation, DM Channel, membership, and event;
- the computer `PUT /v1/workspaces/:botId` creates the bot folder and eagerly calls `ScreenBroker.ensure`;
- pg-boss, durable InboxEvent rows, per-bot leases, and a background WakeWorker exist;
- one Pi session is started on the first wake and resumed for later DM, peer, and group turns;
- `SendMessage` is the only visible agent voice;
- the client snapshot already includes non-archived provisioning and failed bots;
- the inspector already renders a starting screen card and live bot display;
- the shared workspace, bot-scoped displays, separate writable browser profiles, and full computer-scoped browser authority are implemented.

At plan authoring, the remaining gaps were orchestration and product semantics:
server creation blocked on `ScreenBroker.ensure`, onboarding had no first-class
wake, profile fields were incomplete, settings used a modal, and there was no
safe peer-readable transcript mirror. The implementation outcome above records
how each of those gaps was closed.

## Target user flow

### Happy path

1. The user clicks the plus button and chooses **New Bot**.
2. A compact creation surface shows a generated avatar, default name `New Bot`, and one primary button: **Create New Bot**.
3. Clicking the button creates the durable identity and returns immediately.
4. The dialog closes, the new bot row appears, and its DM is selected.
5. The center chat is initially empty; the inspector is available immediately.
6. The screen card says `Starting New Bot's screen…` until the desktop is ready.
7. In parallel, a durable bootstrap wake starts the bot's home Pi session.
8. With no configured role, the bot sends one or two short opening bubbles and asks one concrete discovery question.
9. If the user opens Settings, Name, Title, Description, and Notifications are editable in the right inspector.
10. Closing Electron changes none of this. Provisioning, onboarding, and later turns continue in Compose.

### Configured creation path

The default path remains one click. A secondary **Customize first** affordance may expose Name, Title, and Description before creation. When those fields are present, the bootstrap should begin from the role rather than ask a generic “what should I do?” question.

The advanced runtime `instructions` field should not be placed in the default creation flow. It remains available behind an Advanced section because it is a control-plane instruction, not the same product concept as a human-readable Title or Description.

### User types before onboarding finishes

The user must never be blocked from using a newly committed bot merely because the screen is still starting.

OpenBot will accept the message durably while the bot is provisioning. Ordering rules:

1. if the bootstrap wake has not been claimed, the user message marks onboarding `skipped_by_user`; the first user turn handles the conversation naturally;
2. if bootstrap is already running, the host marks onboarding
   `skipped_by_user`, cancels that turn best-effort, and processes the higher
   priority user wake next;
3. no delayed generic greeting is allowed after a real user turn has started;
4. no visible user bubble is synthesized for the bootstrap.

This preserves user priority without producing a late, irrelevant welcome.

## Lifecycle and invariants

### Bot lifecycle

Use the existing `BotStatus` as the infrastructure lifecycle:

```text
provisioning ──success──> active
      │                    │
      └──retry exhausted──> failed
active/failed ──archive──> archived
```

Add a separate onboarding lifecycle because computer readiness and first conversation are independent:

```text
pending → queued → running → completed
   │          │        └──> failed
   └──────────┴────────────> skipped_by_user
```

Core invariants:

- one Bot has exactly one home Conversation and one bot DM;
- one bot has at most one bootstrap version in flight;
- `bot:<botId>:bootstrap:v1` is a globally unique idempotency key;
- bootstrap is never stored or displayed as a user-authored ChannelMessage;
- a successful visible welcome can only come from that bot's `SendMessage` tool calls;
- provisioning retries never create a second Bot, Conversation, DM, display slot, or browser profile;
- archiving prevents new work and destroys the live screen, but does not silently delete transcripts or workspace files;
- Electron is not in the provisioning or execution path.

## Data and contract changes

### Prisma

Add:

```prisma
enum OnboardingStatus {
  pending
  queued
  running
  completed
  failed
  skipped_by_user
}

enum RunOrigin {
  user
  agent
  group
  bootstrap
}

model Bot {
  // existing fields
  title                   String           @default("")
  description             String           @default("")
  notificationsEnabled    Boolean          @default(true)
  onboardingStatus        OnboardingStatus @default(pending)
  onboardingVersion       Int              @default(1)
  onboardingCompletedAt   DateTime?
  provisioningError       Json?
}
```

Do not overload `instructions`:

- `name`: compact identity label shown everywhere;
- `title`: one-line role shown in discovery/list contexts;
- `description`: longer human-readable charter and default source for role-aware onboarding;
- `instructions`: advanced durable runtime instructions;
- `notificationsEnabled`: delivery preference, not an instruction to the model.

The existing `MessageRole.system` represents the internal bootstrap cue in OpenBot's projection. At the Pi boundary it is supplied as the addressed bootstrap prompt; the OpenBot audit model retains its true bootstrap origin.

### Effect contracts

Change `CreateBotInput` so the zero-input route is valid:

```ts
interface CreateBotInput {
  name?: string;
  title?: string;
  description?: string;
  instructions?: string;
  icon?: string;
  color?: string;
  notificationsEnabled?: boolean;
  clientRequestId: string;
}
```

Server defaults:

- `name = "New Bot"`;
- `title = ""`;
- `description = ""`;
- `instructions = ""`;
- `notificationsEnabled = true`;
- icon/color selected deterministically from `clientRequestId` or the generated Bot ID.

`clientRequestId` makes double-click/retry creation idempotent. Add an idempotency record under scope `create-bot` and return the original `BotView` for identical retries.

Extend `UpdateBotInput` and `BotView` with Title, Description, Notifications, onboarding state, and provisioning error. Keep icon and color supported even when the default settings pane only exposes the avatar.

### API behavior

`POST /api/v0/bots` must:

1. validate/default the request;
2. in one Postgres transaction create Bot, Conversation, bot DM, membership, `bot.created` event, idempotency response, and a transactional `bot-provision` job;
3. return the `provisioning` BotView immediately;
4. never call the computer gateway synchronously;
5. return success even when the computer service is temporarily unavailable.

Expected local latency budget: p95 below 150 ms from button click to committed BotView, excluding a cold database startup.

## Durable provisioning architecture

### Queue

Add a pg-boss queue:

```text
bot-provision
```

The create transaction sends this job through `fromPrisma(tx)` so Bot creation and job publication are atomic. Use a singleton key derived from the Bot ID or a unique domain job record so retries cannot provision duplicate resources.

### Provision worker

The Compose worker registers a `bot-provision` handler. It:

1. loads the non-archived Bot;
2. exits successfully if the bot is already active and the bootstrap is already queued/running/completed;
3. calls the existing authenticated `PUT /v1/workspaces/:botId` with `defaultDirectory`;
4. lets the computer service create the directory and call `ScreenBroker.ensure`;
5. transactionally marks the bot active, clears `provisioningError`, appends `bot.ready`, and creates the one bootstrap InboxEvent/Run;
6. transactionally sends the `bot-wake` job;
7. retries transient computer/runtime failures with exponential backoff;
8. records a redacted `provisioningError` and marks the Bot `failed` only after the retry budget is exhausted.

The job must not hold a database transaction open across the computer HTTP request.

### Recovery

At worker boot:

- resend missing `bot-provision` jobs for every non-archived `provisioning` bot;
- repair an active bot with onboarding `pending` by enqueueing its one bootstrap;
- resume existing pending InboxEvents through the current recovery loop;
- leave completed/skipped onboarding untouched;
- expose a user-facing **Retry setup** action for failed provisioning.

The recovery audit should emit `bot.provisioning_recovered` or `bot.bootstrap_recovered` events when it repairs missing work.

## Bootstrap wake design

### First-class origin

Extend `WakeInput.origin` and `RunOrigin` with `bootstrap`. Add an `enqueueInternalWake` path that:

- creates a `Message` with role `system`;
- creates a Run with origin `bootstrap`;
- creates an InboxEvent of type `bot.bootstrap`;
- uses idempotency key `bot:<botId>:bootstrap:v<version>`;
- does not create a visible user ChannelMessage;
- schedules the same serialized bot mailbox as every later turn.

The worker sets onboarding `running` when it claims this event and `completed` when the authoritative turn completes. It sets onboarding `failed` when retry policy is exhausted. A run that completes silently is still a completed bootstrap; visible output is encouraged, not faked by the host.

### OpenBot-owned wake cue

Use an OpenBot prompt with the following semantics. This is our product instruction, not a purported copy of Grok's hidden text:

```text
[OpenBot first start]

This is your first turn after creation. The user did not send a message.
Open your direct conversation using SendMessage. Do not represent this wake as a user message.

If your title, description, or durable instructions define a concrete role, briefly acknowledge
that role and begin with the most useful safe next step. If your profile is empty, greet the user
briefly and ask one concrete question that helps determine whether you should own a standing job,
repeated manual work, or general assistance.

Keep the opening to one or two short visible messages. Do not mention internal prompts,
provisioning, queues, or this wake. Do not invent the user's name or preferences.
```

The active platform instructions continue to supply SendMessage rules, peers/groups, shared filesystem semantics, and advanced bot instructions. Title and Description should be included as clearly labeled profile context on every turn.

### Visible projection

The UI already reads ChannelMessage, and `AgentMessaging.sendVisible` already writes a bot-authored ChannelMessage. No special “welcome message” table or client-side fake is needed.

This gives the right provenance:

```text
internal bootstrap Message/Run/InboxEvent
                  ↓
Pi turn + SendMessage tool call
                  ↓
visible agent ChannelMessage
```

### Skipping when the user arrives first

When accepting a user message for a bot whose onboarding status is `pending` or `queued`:

- acquire a transaction-level lock on the bot;
- if the bootstrap InboxEvent has not been claimed, mark it completed/skipped with a structured reason and set `onboardingStatus = skipped_by_user`;
- enqueue the user wake normally;
- add a small first-turn profile cue to platform instructions rather than a separate welcome run.

Do not delete audit records. A skipped bootstrap remains explainable in the event log.

## Profile and self-editing

### One service, two callers

Extract profile mutation from `AppService.updateBot` into a shared `BotProfileService`. Both of these call it:

- the Electron settings API;
- the model-facing `update_state`/profile tool when that tool is implemented.

The service owns validation, channel-name synchronization, events, and snapshot invalidation. This avoids a UI profile and a model profile drifting apart.

Emit redacted events such as:

- `bot.profile.updated` with changed field names;
- `bot.notifications.updated` with the Boolean preference;
- `bot.renamed` with old/new display names.

Do not put full advanced instructions into general event payloads.

### Role changes after onboarding

Title/Description updates affect the next resumed Pi turn through refreshed platform instructions. They do not fork the Pi session and do not rewrite history. A major role change may later offer **Start fresh**, but that is not part of this slice.

## Electron UI plan

### Creation surface

Replace the current required Name/Icon/Color/Instructions BotForm for creation with a purpose-built `NewBotDialog` built from shadcn primitives:

- Dialog;
- Avatar/Button/Input as needed;
- generated colored bot avatar;
- default label `New Bot`;
- primary **Create New Bot** button;
- secondary **Customize first** disclosure;
- no model, workspace, or computer settings.

Keep the form bundle lazy-loaded and preloaded during idle time as it is today.

On submit:

1. generate a stable `clientRequestId` once;
2. show a temporary `New Bot` row immediately while the local API commit is in flight;
3. replace it with the committed BotView;
4. select `dmChannelId` and close the dialog;
5. reconcile through the normal snapshot/event stream;
6. retain the dialog with an inline error only if the identity transaction itself fails.

Do not wait for screen status or the opening message before closing.

### New bot chat state

The selected empty chat should render a quiet, deterministic state:

- no fake assistant bubble;
- an optional subtle `Starting New Bot…` activity row tied to bot/onboarding status;
- composer enabled as soon as the durable DM exists;
- queued-message label if the bot is still provisioning;
- visible first bot bubbles stream through the existing AI Elements message components.

### Inspector shell

Move bot settings from a centered modal into the existing right inspector:

```text
summary mode                       settings mode
┌─────────────────────────┐       ┌─────────────────────────┐
│             gear   »»   │       │ ‹       Settings   »»   │
│  screen preview         │       │        avatar           │
│  New Bot's screen       │  →    │ Name                    │
│                         │       │ Title                   │
│  routines               │       │ Description             │
└─────────────────────────┘       │ Notifications toggle    │
                                  └─────────────────────────┘
```

When the entire inspector is closed, show the compact monitor icon in the chat header. Clicking it should open the inspector directly to the computer summary. A separate gear opens settings.

Use shadcn Input, Textarea, Switch, Label, Button, Tooltip, Skeleton, and Separator. Add the shadcn Switch and Context Menu primitives to the source-owned component set.

### Settings persistence

Use optimistic controlled fields with:

- 400 ms debounce for ordinary typing;
- immediate save on blur and toggle;
- cancellation/stale-response protection per field;
- subtle `Saving…`, `Saved`, or error state rather than a permanent Save button;
- rollback only for the field whose mutation failed;
- no full-snapshot refetch for every keypress.

The snapshot reconciler must preserve a locally newer draft while a slower server snapshot arrives.

### Screen state

The current BotScreen already supports a starting skeleton, polling, preview, and interactive noVNC viewer. Update its copy/state binding:

- `provisioning`: spinner/skeleton and `Starting <name>'s screen…`;
- `active + screen starting`: same card, driven by screen state;
- `active + ready`: high-priority preview for selected bot;
- `failed`: explanation plus **Retry setup**;
- archived: no live screen.

The screen must stay warm when Electron is closed because the computer service, not the renderer, owns it.

### Notifications

Persist `notificationsEnabled` now and route completion/needs-input events to Electron's main process when the desktop client is running or resident in the tray.

The preference does not imply that a fully quit Electron process can display native notifications. System notifications while the desktop process is completely absent require a later host notifier or OS background helper. Bot work itself remains fully backgrounded regardless.

### Row context menu and transcript entry

Add a shadcn Context Menu to bot rows only after the reference menu is validated. Proposed OpenBot entries:

- Open computer;
- Settings;
- View transcript;
- Retry setup, when failed;
- Archive bot.

These labels are a product proposal, not a claim that the observed Grok menu contains exactly these items.

## Safe transcript mirror

### Why not expose raw Pi sessions

Pi session JSONL can contain internal instructions, tool arguments, command output, paths, and secrets. Sharing raw session files would turn a convenience feature into uncontrolled cross-bot data exposure.

Postgres remains authoritative. OpenBot materializes a peer-readable, redacted journal with a stable layout inspired by the observed Grok filesystem:

```text
/home/openbot/agent-data/agent-transcripts/
└── <bot-id>/
    └── <bot-id>.jsonl
```

Do not add a `.journal-mode` file merely for visual similarity. Add one only if OpenBot gives it a documented function.

### Safe event schema

Each line is a versioned JSON object such as:

```json
{
  "schemaVersion": 1,
  "sequence": "1842",
  "botId": "...",
  "at": "2026-08-25T12:00:00.000Z",
  "type": "visible_message",
  "channel": { "id": "...", "kind": "bot_dm", "name": "New Bot" },
  "sender": { "kind": "agent", "botId": "...", "name": "New Bot" },
  "content": "...",
  "metadata": { "attachments": [] }
}
```

Initial event types:

- visible user/agent/system channel message;
- peer delivery acknowledgement;
- group delivery cue without hidden prompt text;
- run started/completed/failed summary;
- compaction marker;
- profile-change marker with changed fields only.

Exclude:

- system/developer/platform prompts;
- bootstrap cue content;
- private model reasoning;
- secret-request values and connector credentials;
- raw environment variables;
- approval payloads that contain sensitive commands or paths;
- unredacted tool results;
- internal control tokens and provider request bodies.

### Writer and rebuild path

Only the computer service owns `/home/openbot`. Add an authenticated internal `TranscriptMirror` endpoint/service that:

- serializes appends per bot;
- writes one complete line and fsyncs or safely batches before acknowledgement;
- tracks the last Postgres event sequence;
- can rebuild a bot journal from the authoritative database projection;
- writes through a temporary file and atomic rename during rebuild;
- creates directories with non-world-writable permissions.

A durable `transcript-project` pg-boss job or outbox delivery drives updates. A filesystem write failure never fails the user/bot turn; it leaves a retryable projection backlog and visible degraded health.

### Agent discovery

Only after the safe mirror ships, add the path and schema to `platformInstructions` along with a clear rule:

- transcripts are on-demand reference, not automatically loaded context;
- use Read only for a task-relevant reason;
- do not treat another bot's private user thread as shared group context;
- summarize only what is necessary.

Because the computer filesystem is intentionally shared, this is policy and audit—not OS isolation. The product must say so plainly.

### User transcript viewer

The Electron transcript viewer should use the Postgres-safe projection API, not parse a live file from the renderer. It can offer:

- read-only chronological view;
- source channel and sender labels;
- search within the loaded transcript;
- copy/export of the redacted projection;
- a clear distinction between visible chat and internal lifecycle markers.

Raw internal prompt/rollout access is not part of the user-facing viewer.

## Performance requirements

The onboarding flow must preserve the client-performance work in plans 22 and 24:

- new-bot dialog open to next paint: p95 under 50 ms after idle preload;
- click to committed BotView/selected DM: p95 under 150 ms locally;
- selecting the newly created DM does not wait for a snapshot refetch;
- bot-row and chat identity use stable memoized objects;
- only the selected/warm inspector requests screen status and frames;
- settings keystrokes update local state without rebuilding channel/message indexes;
- bootstrap streaming uses the existing snapshot/event reconciliation path;
- screen frame polling pauses when Electron is hidden, but screen processes remain owned by the computer service;
- no renderer loop creates provisioning or wake jobs.

Record:

- `view.new-bot-open`;
- `mutation.bot-create-commit`;
- `view.new-bot-selected`;
- `bot.screen-ready`;
- `bot.bootstrap-first-visible-message`;
- `bot.onboarding-completed`.

These timings should share `clientRequestId`/Bot ID correlation without logging message content.

## File-by-file implementation map

### Database and contracts

- `packages/db/prisma/schema.prisma`
  - add OnboardingStatus, profile/preference fields, bootstrap RunOrigin, provisioning error.
- `packages/db/prisma/migrations/<timestamp>_bot_onboarding/migration.sql`
  - default/backfill existing bots as `completed` when they already have channel history, otherwise `pending` only when explicitly safe.
- `packages/contracts/src/index.ts`
  - update CreateBotInput, UpdateBotInput, BotView, RunOrigin, snapshot fields.
- contract tests
  - zero-config create, bounds, defaults, and invalid inputs.

### Server and durable queues

- `apps/server/src/app-service.ts`
  - make create transaction-only;
  - add create idempotency;
  - add retry setup endpoint;
  - allow durable user acceptance while provisioning;
  - extract profile service usage.
- `apps/server/src/main.ts` / `apps/server/src/http.ts`
  - wire new endpoints and response schemas.
- `packages/messaging/src/index.ts`
  - add bootstrap origin/internal wake;
  - skip bootstrap transactionally when a user arrives first;
  - include Title/Description and later transcript pointer in platform instructions.
- `apps/worker/src/worker.ts`
  - register provision handler;
  - update onboarding state on claim/completion/failure;
  - recovery and idempotency logic.

### Computer and transcript projection

- `apps/computer/src/main.ts`
  - preserve existing workspace/screen ensure endpoint;
  - add private transcript mirror/rebuild endpoints.
- `apps/computer/src/screen-broker.ts`
  - no lifecycle rewrite; verify idempotent ensure and failed-screen recovery.
- new `apps/computer/src/transcript-mirror.ts`
  - safe append, cursor, rebuild, permissions, tests.
- `docker-compose.yml`
  - no Electron dependency; existing persistent computer-home volume stores the mirror.

### Electron

- `apps/desktop/src/renderer/components/openbot/forms.tsx`
  - split NewBotDialog from advanced/profile editing; keep GroupForm.
- `apps/desktop/src/renderer/App.tsx`
  - immediate committed selection, temporary row, inspector mode, compact monitor control.
- `apps/desktop/src/renderer/components/openbot/inspector.tsx`
  - summary/settings modes and observed layout.
- `apps/desktop/src/renderer/components/openbot/bot-screen.tsx`
  - bind card to bot lifecycle and retry state.
- `apps/desktop/src/renderer/components/openbot/sidebar.tsx`
  - provisioning/failed state, optional context menu, stable row memoization.
- `apps/desktop/src/renderer/components/openbot/chat-pane.tsx`
  - onboarding activity and queued composer state, no fake message.
- `apps/desktop/src/renderer/components/ui/switch.tsx`
  - source-owned shadcn Switch.
- `apps/desktop/src/renderer/components/ui/context-menu.tsx`
  - source-owned shadcn Context Menu after reference validation.

## Delivery slices

### Slice 1: non-blocking durable creation

- schema/contract migration;
- idempotent zero-config create;
- `bot-provision` queue and worker;
- immediate provisioning BotView;
- failed/retry/recovery states.

Exit: with the computer service intentionally stopped, creating a bot still returns and renders a durable provisioning row; bringing the service back completes the same bot rather than creating another.

### Slice 2: proactive first turn

- bootstrap origin and internal wake;
- onboarding state machine;
- profile-aware wake cue;
- user-arrived-first skip;
- visible SendMessage projection and first-message timing.

Exit: an idle new bot proactively sends one or two short messages exactly once; restart/crash/retry does not duplicate them; a user message sent first prevents a late generic greeting.

### Slice 3: Grok-like creation and settings UI

- compact one-click dialog;
- immediate selection;
- inspector summary/settings modes;
- Name/Title/Description/Notifications autosave;
- compact monitor affordance;
- lifecycle-aware screen card.

Exit: the full happy path visually matches the supplied flow at desktop reference sizes and remains usable at narrow widths.

### Slice 4: safe transcript mirror and viewer

- redacted Postgres projection;
- computer-owned JSONL mirror in assistant-ID directories;
- recovery/rebuild;
- platform pointer;
- read-only Electron viewer;
- context-menu affordance after reference validation.

Exit: a bot can locate and read a task-relevant peer journal on demand, but tests prove system prompts, secret values, reasoning, and raw approval payloads never enter the file.

### Slice 5: performance and resilience QA

- instrumentation budgets;
- close-Electron provisioning/bootstrap test;
- worker/computer/server restart matrix;
- high-frequency creation/idempotency test;
- screen and transcript failure injection;
- packaged Electron visual and interaction pass.

## Validation plan

### Unit tests

- CreateBotInput defaults and limits;
- deterministic avatar defaults;
- profile field validation;
- bootstrap cue selection for empty vs configured profile;
- safe transcript redaction and schema;
- onboarding transition guard table;
- user-arrived-first skip logic;
- idempotency keys.

### Database/integration tests

1. repeated create requests with the same `clientRequestId` return one bot/DM/conversation;
2. create transaction and provision job commit atomically;
3. a computer outage leaves the bot provisioning and retryable;
4. recovery resends missing provision jobs;
5. one bootstrap InboxEvent exists after arbitrary retries/restarts;
6. bootstrap uses origin `bootstrap` and no user ChannelMessage;
7. SendMessage creates the only opening agent ChannelMessages;
8. a first user message skips unclaimed bootstrap without losing either audit history or the user message;
9. profile updates rename the bot DM and refresh next-turn platform instructions;
10. transcript projection is ordered, rebuildable, and redacted.

### End-to-end Compose tests

1. Launch fresh Compose with no Electron.
2. Create a bot through the API.
3. Confirm Bot/DM appear immediately with status provisioning.
4. Confirm the worker creates the screen and marks the same bot active.
5. Confirm a Pi session ID/path attaches once and remains the home session.
6. Confirm proactive messages appear without a user ChannelMessage.
7. Quit Electron during a second bot's provisioning and first turn.
8. Reopen Electron and confirm the completed messages and ready screen are present.
9. Create a file in Bot A's desktop; create Bot B; confirm Bot B sees it through the shared filesystem.
10. Confirm Bot A and B have distinct displays/browser profiles.
11. Confirm each safe transcript journal lives in its own ID directory and can be rebuilt after deletion.
12. Stop/restart worker, server, computer, and Postgres at each lifecycle boundary and confirm no duplicate bot or greeting.

### UI/visual QA

- plus menu → New Bot → Create New Bot;
- immediate left-rail insertion and selection;
- collapsed monitor and expanded screen inspector;
- screen loading, ready, failed, and retry states;
- settings geometry, labels, autosave, errors, keyboard order, and screen-reader labels;
- two-message proactive opening without layout jump;
- bot-row context menu with computer, settings, safe transcript, retry when
  applicable, and archive actions;
- light/dark mode and packaged macOS Electron.

### Security QA

- no control token, database URL, OpenAI credential, cookie-encryption key, or secret-request value appears in JSONL;
- no system/developer/platform prompt enters the peer mirror;
- transcript path cannot escape its configured root;
- Bot ID/path values are validated and never used as raw traversal segments;
- browser/display separation is described as organization, not a security boundary;
- UI transcript export uses safe projection, never raw rollout files.

## Acceptance criteria

This work is complete when all of the following are true:

1. A zero-config bot can be created with one primary action.
2. The committed bot and DM are visible before computer readiness.
3. Computer failure does not roll back or hide the bot identity.
4. Provisioning and onboarding continue with Electron fully closed.
5. A new idle bot sends a short opening exactly once without a fake user bubble.
6. A real first user message prevents a stale onboarding greeting.
7. The same Pi session continues across onboarding, DM, peer, and group wakes.
8. Name, Title, Description, and Notifications persist from the inspector and survive restart.
9. The profile has one canonical durable record that a future model-facing state tool can reuse rather than a parallel store.
10. The screen can be opened as soon as ready and shares files with existing bots while keeping its own display/browser profile.
11. Safe peer-readable transcripts use `<bot-id>/<bot-id>.jsonl`, are on demand, rebuildable, and exclude hidden/sensitive content.
12. Create/select/render timings meet the performance budgets.
13. Restart and retry tests prove no duplicate identities, threads, jobs, or proactive messages.

## Explicit non-goals for this slice

- reproducing Grok's private wake or system prompt word for word;
- exposing raw Pi session files to bots or users;
- claiming filesystem privacy between bots;
- implementing full durable memory or routines merely because onboarding mentions them;
- adding multiple users/auth;
- guaranteeing native notifications when the Electron process is fully quit;
- claiming that OpenBot's product-owned right-click actions are Grok's exact
  private menu implementation;
- implementing the broader model-facing `update_state` tool in this onboarding
  slice;
- changing the one-home-thread-per-bot architecture.

## Recommended implementation order

Slices 1 through 5 were delivered in dependency order: durable creation and
bootstrap semantics first, then client projection, safe transcript mirroring,
and resilience/visual QA. This order kept the UI a projection of truthful
server state rather than a client-side simulation of readiness.
