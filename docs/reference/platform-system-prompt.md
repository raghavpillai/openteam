# Platform prompt and non-cloud harness parity

OpenTeam implements compatibility with the observable non-cloud Grok Bot box-harness behavior captured on September 12, 2026 (Grok Bot 0.47.0, host `61261eb`). The packaged prompt assets are `packages/messaging/src/prompts/grok-platform.json` and `managed-skills.json`. Deployment does not depend on the gitignored findings directory. Captured account information and conversation history are not runtime inputs.

The host source SHA-256 is `51b977dd970ea1c1ac18783fb007dbf84f7947e14fb71cf0ff227971d2c9d29e`. This is a compatibility implementation of the observed box harness, not proof of identical model behavior or recovery of server-only instructions. Image generation, Cursor cloud agents and their SCM connection workflow are excluded.

## Prompt and conversation lifecycle

The base prompt has 18 shared sections. Managed workflow instructions are installed as 20 read-only `SKILL.md` files and discovered through the skill catalog. `OPENTEAM_MANAGED_SKILLS=false` puts the workflow prose inline instead. The source-rendered `base-default`, `base-all-features`, and `base-skillified` findings are feature combinations, not three prompt files switched by filename. OpenTeam adapts the workflows to its actual local tools and deployment features.

Connector instructions precede the platform prompt. Profile, instructions, memory, routines, directory and connector sections retain stable snapshots within a compaction epoch. Changes arrive as later instruction/profile notes and fold into the prefix after compaction. Acknowledgements compare the exact section or outcome receipt, so a delayed response cannot erase newer changes. The runtime refreshes context during active compaction and fingerprints the model-visible system text, user-info and tool definitions.

`user_info` includes the actual environment, working directory, transcript guidance, skill catalog, subagent types and dynamic namespaces. Host ambient notes are separate hidden messages before the real user input. Failed user turns with no delivery watermark are reintroduced with stable message IDs and their images; session receipts suppress duplicate delivery after a lost acknowledgement. Cancelled user turns are not replayed through this path.

Pi is patched to persist and fsync the initial user/ambient messages before an assistant response exists, and to notify delivery listeners after the append succeeds. Tool call/result pairs remain in the durable session. `SendToUser.end_turn` stops the loop; queued steering remains in the server inbox for a separate turn instead of being consumed by Pi's post-run continuation. Existing compaction archives, fork contexts, orphaned-steer promotion and context leases remain in use.

New group rooms record the shared workspace as their starting directory, matching worker execution and direct turns. Same-epoch directory edits arrive in later instruction updates, so context consumers must inspect those updates as well as the frozen prefix.

## Tools and review surfaces

44 captured non-cloud tool names are wired. GenerateImage is intentionally excluded at the user's request. Names alone do not certify provider semantics; tests cover contracts, runtime execution, durable state, and the stated external boundaries.

The current main agent exposes 46 core tools: the 44 shared names plus ListAgents and ListGroups. WakeParent is automation-only, bringing the reachable core union to 47. ExternalShell and ExternalRead remain legacy definitions hidden from the active surface; use Shell/Read with machineId. Specialized browser/computer workers and installed MCP connectors expose additional tools. See the [complete tool comparison](README.md).

- **WakeParent:** bot-owned scheduled, manual and event-triggered routines run in a fresh context scoped to the original automation run. WakeParent accepts the complete `message`, atomically saves it and queues a hidden parent wake in the originating channel, then terminates the model loop. Repeated calls across continuation turns share one handoff receipt. Only the main agent sends the user-visible response. A normal final automation message is saved silently and enters the parent's next delivered prompt for the same memory audience; acknowledgement consumes only the exact delivered results. Delegated-worker and shell completions resume the automation context until it hands responsibility to the main agent. This uses the same bot identity and work permissions with separate context sessions; bot run leases still serialize execution. Group-owned routines retain their existing group-round behavior.

Automation runs cannot use chat, reaction, agent messaging, form, handoff, draft, sharing or connector-management review surfaces directly. The catalog and server both enforce the restriction; execution approvals remain available. The automation prompt explicitly overrides normal acknowledgement and SendToUser instructions. The WakeParent schema and queue are an OpenTeam adapter to the captured automation prompt; no exact Grok WakeParent tool schema or private queue implementation was captured. The AutomationResult table is applied by the normal database release flow before starting updated services.

- **Shell/AwaitShell:** numeric handles, bounded RE2 pattern waits, matching group 0, polling/sleep, durable scoped receipts, restart recovery, completion wakes, machine routing and exported environment persistence. Environment state is captured through a private inherited file descriptor, separate from model output. The working directory resets for each call. Replacing Bash with `exec`, overriding its capture trap, killing the shell before capture, or concurrent independent shells can prevent ordinary end-of-command environment capture; use normal sequential shell calls when state must persist.
- **CopyToBox/CopyFromBox:** binary transfers through host read/write approvals and single-use, machine-bound permits; 256 MiB limit; atomic replacement and cancellation cleanup. Transfer bytes stay out of model context. Box file I/O runs as the agent identity.
- **RecallMemory/ListSections/update_state:** scoped memory retrieval, ranked and bounded results, section discovery/agent placement, profiles, skills, routines, tasks and persistent state.
- **WebFetch:** built-in public HTTP(S) with DNS/IP checks and pinning on every redirect, or separately configured Exa Contents/Tavily Extract. No authenticated browser context; bounded responses, Markdown/text extraction, and a file for oversized content. Provider-side crawling runs on that provider’s infrastructure.
- **WebSearch:** database-backed Exa, Tavily, Brave or Bing-via-SerpApi configuration in Settings → Server → Web search, source links/snippets, bounded requests and cancellation. The tool remains visible when unconfigured and returns setup guidance. See [web search configuration](../configuration/web-search.md).
- **Forms:** desktop/mobile form cards, exact website and tab binding, encrypted private held values, browser fills, optional nonsecret prefills, single-use remapping, expiry, and interruption receipts. Values do not enter server messages, transcripts, or events. The host checkpoints intent before filling or pressing Enter; a crash never silently repeats a submission. Only an allowed verification-code form can request Enter after filling.
- **DraftExternalMessage:** verify the sending account and route, then stage an editable email or Slack review. Creating or saving the card sends nothing. Human Send uses a durable connector call ID, preserves immutable account/thread routing, records edited content and delivery outcomes, and never automatically repeats an uncertain send. Reply drafts use create-draft then send-draft; email HTML escapes prose and links. Recovery checks completed connector invocations and marks interrupted delivery as unknown.
- **Feedback:** exact-message review, explicit reply preference, deployment privacy gate, support destination binding, five-minute rate limit, idempotency header, durable outcome and no automatic resend after uncertain delivery. This sends to the configured OpenTeam support endpoint, not xAI support.
- **Templates:** validated recipe staging, versioned human review, team/public publication, revocation, one active published version per bot, JSON export and import. Import materializes memories and shared skills, saves proposed routine Markdown for setup, and gives the new bot getting-started instructions. It does not inherit account grants or start an unconfigured schedule.

Settled form, widget, credential, handoff, draft and review outcomes are replayed until their exact receipt is acknowledged. Pending draft/feedback sends are reconciled at startup and every 30 seconds.

## Deployment configuration

| Setting | Behavior |
|---|---|
| `OPENTEAM_MANAGED_SKILLS` | Defaults on; `false` uses inline workflow instructions. |
| `OPENTEAM_FEEDBACK_ALLOW_AGENT=true`, `OPENTEAM_FEEDBACK_URL` | Enable the reviewed support adapter. HTTPS required except localhost fixtures. |
| `OPENTEAM_FEEDBACK_CONTACT` | Required if feedback requests a reply. |
| `OPENTEAM_FEEDBACK_TOKEN` | Optional support endpoint authorization; never model-facing. |
| `OPENTEAM_TEMPLATE_SHARING=false` | Disable staging/publication. |
| `OPENTEAM_PUBLIC_TEMPLATES=true`, `OPENTEAM_PUBLIC_URL` | Enable public recipes and construct public links. Team visibility remains the default. |
| `OPENTEAM_AUTOMATION_WEBHOOKS_FILE` | Operator-owned JSON bindings for signed Slack/GitHub/generic webhook deliveries. See below. |
| `OPENTEAM_ENFORCE_AUTOMATION_MINIMUM=false` | Explicitly opt out of the default five-minute routine floor. |

The database schema adds prompt-section snapshots, a pending template recipe and user-input delivery watermarks. Apply the schema through the normal release/update flow before running the rebuilt services. No deployment or shared-stack restart is performed by the research tests.

## Event routines

Authenticated normalized events enter `POST /api/v0/internal/automation-events` with the existing control token and `{owner:{kind:"bot"|"group",id},event}`. Matching covers Slack, GitHub/Origin, Teams, Linear, Sentry, PagerDuty and generic webhook trigger shapes. Stable event IDs deduplicate execution; paused listeners stay paused and overlapping events are recorded as skipped. Event payloads are explicitly untrusted data.

For direct provider webhooks, configure an operator-owned file containing bindings such as:

```json
[
  {
    "id": "repository-events",
    "source": "github",
    "owner": { "kind": "bot", "id": "REPLACE_WITH_BOT_UUID" },
    "repository": "owner/repository",
    "secretEnv": "OPENTEAM_EVENT_GITHUB_SECRET"
  }
]
```

Point the provider subscription to `/api/v0/automation-hooks/repository-events` on the public deployment URL. Set the signing secret through deployment configuration, not chat. Slack bindings require `teamId`; `selfUserId` enables self-reaction/mention matching and `channelNames` maps channel IDs to the names used by saved listeners. GitHub bindings require a repository. Generic webhook bindings accept the normalized event shape and an `x-openteam-signature-256: sha256=<HMAC-SHA256 of raw body>` header.

Slack verifies the raw-body HMAC and five-minute timestamp window; GitHub verifies `x-hub-signature-256` and repository binding. These follow the [Slack verification protocol](https://docs.slack.dev/authentication/verifying-requests-from-slack/) and [GitHub webhook verification protocol](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries). DB-backed Server settings now provisions provider subscriptions for GitHub, Slack, Linear, Sentry, PagerDuty and Teams, with authenticated ingress adapters. See [event subscriptions](automation-event-subscriptions.md). A local listener uses its owner's configured provider binding; it cannot create missing provider credentials. Terminal or time-limited watches use their saved workflow to delete/pause themselves; they are not an undisclosed remote subscription service.

## Verification limits

Tests use synthetic connectors for external sends, real PostgreSQL for state/recovery, real Chromium for form filling and review-card interactions, and the real Pi serializer/loop with a synthetic provider stream. Real host/box binary transfer and live public WebFetch were exercised. No test sends email or Slack messages to real recipients. Desktop and mobile share draft-edit parsing and validation; mobile cards were typechecked, but the full flow was not exercised on a physical iPhone.

The former xAI search/image adapters were replaced after the investigation: GenerateImage was removed and WebSearch now uses explicitly configured search providers. All four current search adapters have protocol-fixture coverage; successful searches using a real account require its valid API key and quota. Cloud agents, private server-side prompt additions, proprietary retrieval ranking and identical model outputs are not claimed.

To rerun database acceptance, set `OPENTEAM_TEST_DATABASE_URL` to a disposable PostgreSQL database, apply the schema there, and run `bun test ./apps/server/test ./packages/messaging/test ./packages/contracts/test`, followed by `bun test ./apps/worker/test`. These suites reset test state; do not point them at application data or run the two commands concurrently. Run `bun test ./apps/computer/test` separately from `bun test ./apps/desktop/test/host` because their process mocks overlap. Strict Turbo environment filtering does not forward the test database variable by default. The actual Electron review-card fixture is `bun --filter @openteam/desktop test:parity-review`; it uses synthetic responses and sends no external messages.

September 14 additions: foreground Task and independent model selection; named process secrets with output redaction; MCP argument compatibility; source-labelled tool-result fences at normal and compaction model boundaries; current form saved-key discovery; per-room working contexts; concurrent automation roots with one pinned executor for group routines; memory synthesis/overflow audit events; native external attachments; and plugin component execution. These adaptations retain OpenTeam identity and deployment paths. Neither byte-identical private prompts nor identical probabilistic model/classifier output is asserted.

## Current parity limits

The September 14 additions implement the thirteen tools described in [native capabilities](native-capabilities.md), provider event subscription management, imported plugin lifecycle components, foreground tasks, room working-context isolation, automation concurrency, source-labelled result fences and memory reporting. Named profile colors are accepted alongside hex colors; the native robot artwork remains OpenTeam-specific.

Each deployment currently has one human user. User-scoped memory belongs to that deployment owner; multiple bots or bot group conversations do not imply multiple human accounts. Cross-account teams, separate sender-owned memory stores and per-person access isolation are outside the current scope, not parity blockers. Live voice calls, virtual cards, dedicated sibling-thread/App Home/team-onboarding tools and Grok billing are also absent. Private server prompts, native tape wire format and exact classifier/model behavior cannot be certified from the captured source.
