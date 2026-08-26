# Codex runtime

Status: superseded by `27-pi-agent-runtime.md`  
Last updated: 2026-08-25

> Historical decision record only. OpenBot no longer runs Codex app-server. The live runtime embeds Pi and uses Pi's `openai-codex` OAuth provider. Do not implement new behavior against this document.

## Driver choice

Use [`codex app-server`](https://developers.openai.com/codex/app-server/) as the v0 driver, not the higher-level Codex SDK.

The official documentation positions app-server as the interface for rich product integrations that need authentication state, conversation history, approvals, and streamed agent events. The [Codex SDK](https://developers.openai.com/codex/sdk/) is a smaller server-side TypeScript library for programmatically starting, continuing, and resuming coding threads and is especially appropriate for automation or CI.

OpenBot needs the richer surface because its UI must show commands, file changes, progress, approvals, and durable threads. This choice also lets the OpenBot application stay on Bun: the TypeScript adapter talks JSON-RPC/JSONL to the external Codex process instead of depending on the SDK's documented Node.js runtime requirement.

## Integration boundary

`packages/codex-client` owns every app-server detail and is hosted by the private computer gateway. No server route handler or React component sends raw JSON-RPC.

The adapter exposes operations resembling:

```ts
interface CodexRuntime {
  readonly startConversation: (options: StartOptions) => Effect<ConversationHandle, RuntimeError>
  readonly resumeConversation: (threadId: string) => Effect<ConversationHandle, RuntimeError>
  readonly startTurn: (input: TurnInput) => Stream<RuntimeEvent, RuntimeError>
  readonly cancelTurn: (threadId: string, turnId: string) => Effect<void, RuntimeError>
  readonly resolveApproval: (request: ApprovalDecision) => Effect<void, RuntimeError>
  readonly compact: (threadId: string) => Effect<void, RuntimeError>
  readonly readConversation: (threadId: string) => Effect<RuntimeConversation, RuntimeError>
}
```

The exact Effect types will be refined during scaffolding. The principle is a narrow, testable port with OpenBot domain events.

## Process lifecycle

1. The computer gateway's runtime supervisor starts one pinned `codex app-server` child process with stdio transport.
2. It sends `initialize` with OpenBot client metadata and stable capabilities, then sends `initialized`.
3. A read loop parses one JSON object per line and routes responses, notifications, and server-initiated requests.
4. A process-scoped request counter identifies outgoing JSON-RPC calls.
5. Effect `Scope` owns child-process termination, read-loop fibers, pending deferred responses, and subscriptions.
6. On unexpected exit, all pending calls fail with a typed process error, the supervisor applies bounded backoff, and in-flight product runs move through recovery.

Use stdio inside the computer container. The OpenBot server coordinates that gateway over OpenBot's private typed control channel. The official documentation describes app-server WebSocket transport as experimental and unsupported, so it is not an MVP dependency.

## Protocol pinning

- Pin the Codex CLI/app-server version in the server image.
- Run `codex app-server generate-ts --out ...` from that exact version.
- Commit the generated schemas beside a handwritten compatibility layer.
- Check generated output in CI and fail when the binary and committed schema drift.
- Initialize without `experimentalApi` for v0.
- Log unknown methods as sanitized compatibility warnings; never crash the entire server because of an ignorable notification.

## Thread mapping

- One OpenBot conversation maps to one non-ephemeral Codex thread.
- `thread/start` receives the bot's default working directory on the shared computer as `cwd`, configured model, sandbox, approval policy, personality defaults, and an OpenBot service name. The sandbox may expose the shared `/workspace` because cross-bot file handoff is intentional.
- Store both returned `thread.id` and `thread.sessionId`; never derive session identity.
- Use `thread/resume` for subsequent turns after runtime restart.
- Use `thread/read` for diagnostic reconciliation without loading/subscribing to a thread.
- Do not use thread forks or paginated/experimental history in v0.

The empty default OpenBot conversation is created with the bot; its Codex thread is created lazily on the first message. Once an OpenBot conversation stores a Codex thread ID, that association is immutable.

## Instructions

Keep bot persona/instructions in product state and inject them through the stable thread configuration supported by the pinned generated app-server schema or through explicit initial thread context. Treat any `AGENTS.md` loaded from `cwd` as shared project instructions, not as one bot's identity. App-server reports loaded instruction sources when starting or resuming a thread; record those paths as diagnostics and never overwrite a project file to change a bot persona.

Instruction updates apply prospectively. The UI should say that an existing conversation may retain earlier context. A later version may offer an explicit "start fresh with new instructions" action.

## Event projection

Relevant lifecycle events include:

- thread and turn start/completion;
- agent-message deltas and completed messages;
- reasoning summaries, without exposing unsupported hidden reasoning;
- command execution and output summaries;
- file-change items and diffs;
- tool activity;
- context-compaction items;
- errors and cancellation;
- command, file-change, permission, or user-input requests.

Deltas are provisional. The official protocol says the completed item is authoritative, so the projection layer replaces provisional content with the completed payload before marking a row final.

## Approvals

App-server can issue server-initiated requests for commands and file changes. The adapter must:

1. persist an OpenBot approval before presenting it;
2. retain the live request correlation only inside the runtime layer;
3. scope it by conversation, thread, turn, and run item;
4. validate that a submitted decision is still pending;
5. answer the exact app-server request once;
6. persist the resolution and resulting completed item.

Default v0 policy: allow work within the shared `/workspace` under the runtime sandbox; require explicit approval for broader computer-home, system, network, or elevated actions. Bot folders organize work but do not isolate bots. Never default to unrestricted physical-host access.

## Authentication

"No auth" applies to OpenBot users, not the upstream model. App-server supports API-key and ChatGPT-managed authentication modes. For the first self-hosted slice:

- support one documented operator-selected upstream mode;
- prefer a deployment secret/environment reference for an API key because it avoids building a login UI;
- never return the credential through the API, renderer IPC, logs, database, or diagnostics;
- expose only a safe state such as `ready`, `missing`, or `invalid` to the desktop.

ChatGPT-managed login can be a later settings flow; it is not required to prove the product loop.

## Model policy

Do not hard-code a model name in product records for v0. Resolve a server default from validated configuration and let app-server report the active provider/model. A later bot setting can override it. This keeps the MVP from coupling its data model to a changing model catalog.

## Compaction and long context

App-server exposes native context-compaction items and a stable `thread/compact/start` method. v0 should:

- render automatic compaction as a quiet system activity;
- rely on the native thread for model-visible context;
- optionally wire `/compact` to `thread/compact/start` after the main acceptance path is complete;
- avoid a second summarization loop or vector-memory store.

Durable facts that should survive across separate conversations are a later explicit memory feature, not an accidental transcript dump.

## Failure behavior

- Missing upstream credential: server remains healthy for CRUD and history, runtime reports not ready, new turns fail with an actionable typed error.
- Child process crash: interrupt active runs, expire orphaned approvals, restart with backoff, resume the conversation on its next turn.
- Missing rollout for a stored thread ID: mark the conversation detached; keep transcript and shared-computer files readable; do not silently start a replacement.
- Context-window or usage-limit error: persist the typed failure and present a focused recovery action.
- Protocol mismatch: fail runtime readiness with the pinned binary and generated-schema versions in diagnostics.

## Native tool ownership

The ten observed Grok-native descriptors do not all belong in one custom tool server:

- `Shell` and `Read` map to Codex's own model-facing computer capabilities. OpenBot projects their command/file/tool items and approvals instead of wrapping them with a second execution policy.
- `Screenshot` is implemented by the shared-computer screen manager and returned as a provenance-bearing artifact.
- `SendMessage`, `ReactToMessage`, `SendToAgent`, and later typed state commands are first-party OpenBot control-plane tools exposed with host-bound bot identity.
- `GetDynamicTools` and `CallDynamicTool` are optional compatibility/meta-tools over OpenBot's authorized catalog and dispatcher. They do not bypass direct typed MCP calls.
- `ExternalRead` and `ExternalShell` belong only to the future enrolled physical-host bridge and never execute inside the renderer or ordinary Compose server.

Stable app-server `command/exec` and filesystem APIs are useful for OpenBot-initiated orchestration, while stable MCP status/resource/tool-call methods support configured connectors. OpenBot deliberately admits the experimental `dynamicTools` field only for its pinned `SendMessage` and `SendToAgent` native tools. The declaration and `item/tool/call` callback lifecycle are covered by the fake app-server contract test and must be revalidated before every Codex pin update. See `13-native-tool-surface.md` for schemas and delivery stages.

## Post-v0 plugin integration

OpenBot will own plugin discovery, installation, account connections, bot grants, and tool policy. Codex remains the agent driver, not the product catalog.

- Use stable Codex skill inputs and extra roots for bot-enabled plugin skills.
- Adapt connector definitions through an OpenBot-owned MCP gateway and the pinned stable MCP surfaces.
- Do not use app-server's plugin list/read/install/uninstall methods while the official documentation marks them under development.
- Do not require experimental dynamic tools.
- Before connector delivery, prove that the effective MCP tool catalog is enforced per bot/thread. If one app-server process cannot safely vary the catalog, introduce a process/configuration boundary for plugin-enabled bots rather than relying on renderer filtering.

The full package, OAuth, multi-account, policy, and rollout design is in `11-plugin-architecture-research.md`.

## Agent communication

`SendToAgent` and `SendMessage` are first-party OpenBot control-plane tools declared as thread-scoped app-server dynamic tools, not third-party plugins. They use the following app-server primitives around that callback:

- `thread/resume` to load the recipient bot's home thread;
- `turn/start` to deliver a trusted peer envelope on a fresh turn;
- `turn/interrupt` to implement allowed priority supersession and wait for its authoritative interrupted completion;
- ordinary streamed turn/item events for recipient work and projections.

The model-supplied schema intentionally has no `sender_id`. The computer gateway binds the callback to its active run, and the server revalidates bot, conversation, channel, delivery, and running status before dispatch. One app-server process may host multiple threads because caller identity is recovered from the gateway's active-turn record rather than accepted from tool arguments.

Each bot has one active turn across every origin. User turns outrank peer work; priority peer messages may interrupt only non-user turns. Details, verbatim observed schemas, and acceptance criteria are in `12-agent-communication.md`.

Group chat keeps the same private home thread per bot but adds a PostgreSQL-owned ordered round. Each member gets an independent `turn/start` containing a structured delta; later members may see earlier same-round room replies. Do not construct guessed Chat Completions message arrays or inject forged assistant/tool items. A group turn publishes only through explicit `SendMessage`; ordinary agent output remains internal and no send means `handled_silent`. See `15-agent-group-chat-runtime.md`.
