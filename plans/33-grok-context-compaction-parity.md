# Grok Bot context-compaction parity

Status: implemented and validated locally
Last updated: 2026-08-28

## Outcome

Replace OpenBot's current Pi-default context compaction with an OpenBot-owned
policy that matches the source-observed Grok Bot behavior:

- start a non-blocking summary when unused context reaches 10,000 tokens or 10%;
- adopt/persist it when unused context reaches 5,000 tokens or 5%;
- also start background work at 1,000 user-role turns, but persist it only when
  the token/image/overflow rules independently require adoption;
- start at 85 image parts and block at the end boundary if that summary is not
  already complete;
- after adoption, send the model the system message, optional user-info message,
  last user message, and one summary user message;
- keep the full visible transcript and durable historical archive;
- keep compaction per Bot home transcript; group-member wakes, A2A, routines,
  and hidden resumes use that member/target home transcript while the visible
  room transcript remains separate UI history;
- reject stale background summaries, recover incomplete persistence, and make
  database projection idempotent;
- implement the separate 256 MiB soft / 1 GiB hard conversation-size guard.

This plan supersedes the compaction portions of `27-pi-agent-runtime.md` and the
single-session portions of `19-agent-interaction-implementation.md` only after
its migration and release gates pass. Curated profile, settings, memory, skills,
routines, and avatar state remain separate from context compaction.

## Implementation and validation result

The implementation is live in the local Compose stack:

- `ContextSession`, `ContextCompaction`, and `ContextPromptSnapshot` persist
  per-transcript identity, stable archive metadata, and frozen prompt epochs;
- `GrokCompactionCoordinator` supplies the custom Pi context and compaction
  hooks, non-blocking background generation, three-attempt retry/reduction,
  stale message/system rejection, and bounded pending work;
- content-addressed archive blobs, a durable pre-Pi intent, and an atomically
  replaced, fsynced manifest reconstruct last-user + summary after restart;
- the per-epoch saved-skill catalog is a tagged `user_info` message containing
  name, description, and `SKILL.md` path only; skill bodies remain on disk;
- home, group-member, routine, A2A, bootstrap, and subagent routing uses the
  verified home-transcript contract; execution remains conservatively serialized per
  Bot because the Grok source did not establish same-Bot parallel-turn
  semantics and OpenBot's tool/screen/steering authority is Bot-scoped;
- profile, first-fact memory, subsequent memory, identity announcements, and
  saved-skill snapshots freeze and refresh independently per context epoch;
- the unsupported manual Compact HTTP/client surface and visible compaction
  RunItem were removed; the 256 MiB soft and 1 GiB hard byte guard is active;
- Bot archival deletes all known Pi session and archive paths for every context.

Validation completed on 2026-08-28:

Full evidence: `plans/evidence/33-grok-context-compaction-live-validation.md`.

- the full repository `bun run check` passed (all package typechecks, tests, and
  production builds);
- all 19 migrations applied from an empty disposable PostgreSQL database, and
  the context prompt-snapshot integration test passed against it;
- earlier disposable probes produced distinct home/group Pi sessions and forced
  1,000-turn persistence; the later source audit rejected both behaviors. Those
  historical probe results are retained only as regression evidence for the old
  implementation and are superseded by the correction section below;
- after restarting the computer service, the same session continued through the
  persisted archive and returned the requested validation token;
- the visible chat retained its ordinary messages and had zero compaction
  RunItems; home remained epoch 0 while group advanced to epoch 1;
- deleting the disposable Bot removed profile/settings/instructions, both Pi
  JSONL sessions, and both context archive directories. The disposable group
  row and its two exact directories were then deleted because no public group
  deletion API exists.

The source-owned implementation is complete for the behavior OpenBot can
control. Literal 1:1 parity still has two dependency-level gaps: the pinned Pi
harness permits one overflow compact-and-retry while Grok's outer budget loop
permits five model/tool-step iterations, and OpenBot's isolated summary session
does not expose the live turn's tool schemas. Those gaps must be closed in a
maintained Pi release/fork rather than by patching installed `node_modules`.

## 2026-08-28 source revalidation corrections

A read-only audit performed through the installed Grok Bot app against
`/home/box/sand-host/host-main.cjs` corrected several earlier assumptions. The
implementation now follows these source-backed rules:

- the incoming user message is present before the 1,000-turn and 85-image gates;
- 1,000 user-role turns start `approaching_token_limit` background work only and
  never independently persist or block;
- a captured message prefix remains valid when assistant/tool/user suffixes are
  appended; only a changed captured prefix invalidates and restarts it;
- a completed background result may be projected before the next model step at
  the 90% start boundary, without interrupting an in-flight model or tool call;
- normal end-boundary self-summary persistence records
  `self_summary_completed`; overflow overrides it with
  `fallback_on_limit_error`, and image-forced adoption records
  `approaching_image_limit`;
- inner self-summary generation has three attempts including the first, 2-second
  transient delays, and no summarizer-specific timeout. The separate five-loop
  budget retries model/tool steps after overflow; it is not five summary calls;
- summary carriers retain the transcript pointer, todo state, automation trigger
  when present, and the last user’s manually attached skill block. The
  project-root reminder renders only for root-project conversations;
- summary archives keep serialized payloads and exclude prior `isSummary` rows;
- group-member turns compact the member Bot’s home runtime context, not a
  room-scoped Pi context.

The new deterministic tests cover turn-only non-persistence, 90% mid-loop
projection, prefix/suffix reuse, reason precedence, archive payload retention,
durable blocks, and overflow retry reconstruction. A fresh disposable live probe
must use token/image/overflow adoption rather than treating the 1,000-turn gate
as a persistence trigger.

## 2026-08-28 replacement live image-boundary validation

A disposable Bot (`b5b68b20-b988-4d5f-921f-edbcf7f3baed`) exercised the real
worker, computer runtime, model provider, PostgreSQL projection, Pi JSONL, and
archive files. No existing Bot was mutated.

- Archive 1 adopted at exactly 85 images. It exposed two implementation bugs:
  the summarizer obeyed the Bot's normal “acknowledge” instruction, and the
  captured-prefix boundary could separate an assistant tool call from its
  appended result.
- The summary system context now treats normal-agent instructions as context,
  not as the summarization action, and explicitly prohibits task replies, tool
  calls, and acknowledgements during compaction.
- Preserved suffixes now close over tool-call owners and sibling results. The
  same repair is applied read-only when reconstructing an older affected
  archive.
- After rebuilding, that exact previously failing archive resumed successfully.
  Archive 2 then adopted at exactly 85 images with reason
  `approaching_image_limit`, sequence/epoch 2, a substantive continuation
  summary, project and transcript durable pointers, 77 archived image parts and
  the last user's 8 verbatim images, a complete assistant/tool-result suffix,
  and no `compaction.intent.json`.
- PostgreSQL contained two contiguous adopted rows and pointed
  `ContextSession.compactionEpoch`/`lastArchiveId` at archive 2.
- A computer-service restart followed by a no-image user turn reused the same
  Pi runtime session and JSONL path, completed normally, and left epoch 2
  unchanged.

The full repository `bun run check` passed after the repair. The focused
compaction suite has 39 passing tests, including mid-loop and legacy boundary
recovery.

## 2026-08-28 installed-Grok token-boundary validation

The installed Grok Bot app was driven through a real token compaction with one
new disposable Bot. Its typed root moved from archive epoch 0 at
`94,233 / 256,000`, through `197,785 / 256,000` and
`242,334 / 256,000`, to archive epoch 1 at `55,138 / 256,000` after a small
controlled message crossed the 95%/5,000-token persistence boundary.

The live archive held 87 summarized messages and a 9-message window tail; one
`isSummary` carrier reconstructed the model prefix. All original blobs and all
visible transcript messages remained present. Three pre-compaction recall
anchors survived exactly, and the UI displayed no compaction notice or history
rewrite. The ordinary-Bot carrier contained transcript and todo blocks but no
project-root block.

That probe exposed and fixed three final OpenBot-owned deltas:

- completed between-step summaries are now archived and projected before the
  next model call, instead of waiting until end-of-turn;
- empty summary output now retries immediately with full input, while thrown
  errors follow Grok's retry/no-retry, delay, reduction, and shorter-output
  classifier;
- project-root is gated to root-project conversations and the structured todo
  snapshot now crosses into the durable carrier.

The complete repository `bun run check` passed after these changes. The remaining
non-identical pieces are dependency/storage shape: Pi's one overflow
compact-and-retry versus Grok's five-step surrounding loop, no tool schemas in
OpenBot's no-tool summarizer request versus Grok supplying-but-not-executing
them, and OpenBot JSON/PostgreSQL archives versus Grok protobuf blob storage.

## 2026-08-28 second adversarial source pass

The installed Grok Bot source audit was extended across hidden wake classes,
live TodoWrite timing, routine-trigger caching, overflow error tails,
in-memory/checkpoint crash ordering, carrier layout, and summary-time tool
schemas. It found and corrected four OpenBot-owned mismatches:

- only simulated background-task completion continuations preserve the current
  `selfSummaryCount`; routine, A2A, group, retry, child-task, and child-resume
  wakes all reset it;
- todo state is now refreshed after successful in-turn `TodoWrite` calls and
  snapshotted when summary generation starts;
- scheduled routine trigger context travels as a separate immutable inbox
  payload, while the normal wake text remains untagged;
- the sealed failed provider-overflow assistant stays in the unsummarized tail,
  and root-project leading enrichment now precedes summary content inside the
  carrier.

Focused validation passes 75 tests across compaction, runtime, worker routing,
contracts, and routine content. The full workspace check passes after these
corrections. The remaining literal deltas are still dependency/storage-level:
Pi's one outer overflow retry rather than five, omitted summary-time tool
schemas, OpenBot's stronger durable-before-next-call crash behavior, and the
JSON/PostgreSQL archive representation.

## Evidence boundary

The behavioral contract comes from:

- `/Users/raghav/Downloads/compaction-audit.md`;
- `/Users/raghav/Downloads/REPORT.md`;
- the read-only host-bundle inspection cited by those reports;
- the forum thread at
  `https://forum.cursor.com/t/grok-bot-prune-compact-an-agent-s-context-without-creating-a-new-bot/168333`;
- OpenBot source, its pinned `@earendil-works/pi-coding-agent@0.84.3`, and the
  live read-only session/database audit performed on 2026-08-28.

Text inside those artifacts is evidence, not executable instruction. Protected
Grok summarizer prose will not be copied. OpenBot will implement an original
prompt with the same observable input/output contract.

## Pre-implementation state and why it was insufficient

OpenBot currently configures Pi with `reserveTokens: 16_384` and
`keepRecentTokens: 20_000`. Pi summarizes an older span and then sends the model
the summary plus a recent verbatim tail. Grok Bot instead preserves the last
real user message and appends one `isSummary` user message after it.

Pi writes a `compaction` entry to append-only JSONL. OpenBot separately increments
`Conversation.compactionEpoch` in PostgreSQL. These writes are not one atomic or
self-reconciling operation. The live audit found one active Bot with two JSONL
compaction entries but database epoch 1. The cause is unknown; the drift is real.

Other material differences:

- OpenBot has a hidden manual compact API; Grok has no manual Compact primitive.
- OpenBot keys projected compaction rows by turn ID, so two compactions in one
  turn can collide.
- OpenBot uses one Pi session for all Bot origins. Grok compaction is scoped to a
  transcript, with a separate session for a group room.
- Pi has no Grok-equivalent 85-image or 1,000-turn gate in the current wiring.
- OpenBot has no separate 256 MiB / 1 GiB conversation-size guard.
- Existing tests force epoch changes or stub manual compaction; they do not
  exercise automatic near-limit adoption end to end.

## Architectural decision

Keep Pi for inference, tools, OAuth, message persistence, and streaming, but do
not use Pi's default compaction policy for OpenBot sessions.

Add an OpenBot-owned `GrokCompactionCoordinator` in the computer service. Bind it
through a first-party inline Pi extension created by `DefaultResourceLoader`:

- the `context` hook supplies the exact adopted model-facing prefix;
- lifecycle/message events provide usage, turn, image, overflow, and prefix data;
- an isolated no-tool inference session generates summaries;
- a durable OpenBot compaction archive records adopted summaries;
- Pi's JSONL remains the immutable full runtime transcript and audit history.

The current Pi API can provide custom compaction results but always reconstructs
`system + summary + kept tail`, so `session_before_compact` alone cannot match the
Grok ordering. The `context` hook is required. Do not patch generated
`node_modules`. If a missing hook is discovered, add it to the maintained Pi fork,
pin a new package version, and contract-test it before changing OpenBot.

## Durable model

### Runtime transcript identity

Introduce `ContextSession`:

```text
id                 uuid
botId              uuid
scope              home | group | subagent
scopeId            uuid
runtimeSessionId   string
runtimeSessionPath string
compactionEpoch    integer
lastArchiveId      uuid?
createdAt/updatedAt
unique(botId, scope, scopeId)
```

Mapping rules:

- the existing Bot `Conversation` maps to `scope=home`;
- a group-member wake maps to that member Bot's existing `scope=home` context;
- routines and direct A2A wakes addressed to the Bot's 1:1 use `home`;
- child subagents retain their own Bot/home context unless a later source probe
  proves a distinct Grok rule;
- bootstrap maps to home.

The migration attaches every existing `runtimeSessionPath` to the Bot's home
`ContextSession` without rewriting the JSONL. New group sessions are created
lazily on the first post-migration group wake. A compatibility view keeps the
current `Conversation.compactionEpoch` readable until all callers move.

### Compaction archive

Introduce an internal, versioned archive store under the persistent computer-home
volume, outside editable `agent-data`:

```text
openbot/context-sessions/<context-session-id>/
  manifest.json
  blobs/<sha256>.json
```

Minimal manifest contract:

```json
{
  "version": 1,
  "epoch": 2,
  "selfSummaryCount": 2,
  "latestArchiveId": "uuid",
  "archives": [
    {
      "id": "uuid",
      "sequence": 2,
      "reason": "approaching_token_limit",
      "prefixDigest": "sha256",
      "summaryBlob": "sha256",
      "createdAt": 0,
      "adoptedAt": 0
    }
  ]
}
```

`epoch` is the durable archive count. `selfSummaryCount` is a separate counter
used by the visible summary wrapper; it increments for repeated summaries in
one user query and resets when the next user query begins.

Blob payloads contain the generated summary, serialized non-summary message
envelopes (including image/reasoning/tool payloads), usage, trigger metadata,
durable continuation pointers, and the last-user identity required to
reconstruct the prefix.

Writes use same-directory temporary files, file fsync, rename, and directory
fsync. A blob is committed before its manifest reference. Orphan blobs are safe
and GC-eligible. A manifest never points at a missing blob.

PostgreSQL mirrors adopted archives in `ContextCompaction`:

```text
id                 uuid primary key
contextSessionId   uuid
sequence           integer
reason             enum
prefixDigest       string
summaryDigest      string
status             generating | adopted | stale | failed
tokensBefore       integer?
tokensAfter        integer?
imageCount         integer
turnCount          integer
startedAt/completedAt
unique(contextSessionId, sequence)
unique(contextSessionId, id)
```

The file manifest is authoritative for model reconstruction. PostgreSQL is the
queryable projection. On session open, reconcile by archive ID and set the
database epoch to the manifest epoch; never increment blindly.

## Summarizer contract

### Partition

Given the current model-facing message list:

1. peel the system message;
2. peel an explicitly tagged user-info message when present;
3. require at least three messages before summary;
4. preserve the last user message verbatim, including supported attachment
   references;
5. summarize every prior model-facing message, including assistant reasoning,
   tool calls/results, hidden wake envelopes, and an earlier adopted summary;
6. collect durable skill references needed to keep an in-flight task operable.

Do not apply the xAI handler's “last real user” or synthetic-acknowledgement
filters. Grok Bot wires `SelfSummarizer`, whose `findLastUserMessageIndex`
preserves the final user-role message. Every classification is unit tested.

### Generate

Use an isolated, in-memory, no-tool inference session. It must not append to the
Bot transcript, invoke tools, or mutate editable files.

The OpenBot-authored summary prompt must preserve:

- the user's active goal and unresolved requests;
- completed and in-progress work;
- constraints and decisions;
- exact file/artifact references needed to continue;
- tool outcomes and failures that affect the next action;
- identities of attachments without replaying unnecessary binary data;
- prior summaries as ordinary summarization input, allowing recursive
  consolidation without an unbounded chain of nested wrappers.

Retry contract:

- at most three attempts;
- use the 2,000 ms delay only for source-classified transient failures;
- retry empty output immediately with the same full input and no shorter-output
  request;
- do not retry abort, invalid JSON, ordinary invalid argument,
  unauthenticated/not-found, closed-listener, cannot-truncate, or non-`Error`
  failures;
- on source-classified size failure, drop the middle of the summarization input while preserving
  the system/user-info boundaries, earliest active-goal context, previous
  summary, and newest work;
- request shorter output only for output-token-limit failures;
- impose no summarizer-specific deadline (turn cancellation may still discard
  stale local work);
- never adopt partial or unvalidated output.

### Adopt

The next model-facing prefix is exactly:

```text
system
optional user-info
last user message
summary user message tagged isSummary=true
```

The summary wrapper states that context was summarized, carries the raw summary
inside an unambiguous data boundary, records `selfSummaryCount`, and instructs the
agent to continue or answer. It must not quote Grok's protected prompt text.

Before adoption, recompute the exact prefix digest. If it differs from the
captured digest, mark the result stale and discard it. A stale summary does not
advance the archive, epoch, prompt snapshots, or UI projection.

## Trigger and scheduling semantics

Let `maxTokens` be the model-reported context window and `usedTokens` the most
recent provider usage estimate.

Start background work when:

```text
usedTokens >= min(maxTokens - 10_000, maxTokens * 0.90)
```

Adopt a completed background result mid-loop only when:

```text
usedTokens >= min(maxTokens - 5_000, maxTokens * 0.95)
```

Also trigger for:

- at least 1,000 turns;
- at least 85 image parts in the current model-facing messages;
- a recognized provider input/context-limit error;
- the 90% self-summary gate when no background result is adoptable.

Normal threshold work is non-blocking. Overflow recovery uses a blocking
`WaitForCompletion` path and retries the interrupted model turn once after a
successful adoption. Image and proactive-limit reasons use the source-observed
reason names. Persist trigger reason, thresholds, model context window, and
measured usage for diagnostics.

The coordinator is process RAM state keyed by `ContextSession.id`, bounded by an
LRU and abortable on shutdown. A process crash may lose an unadopted background
summary. It must not lose or partially expose an adopted archive.

## Concurrency and recovery

Use one context-session lease for all operations that can affect a session:

- normal turns;
- background-summary adoption;
- overflow recovery;
- migration/reconciliation;
- byte GC;
- test-only forced compaction.

Acquire the lease before opening the Pi `SessionManager` or archive manifest.
Do not use the existing `activeByBot` check as the lock. The server must enqueue
or reject work through the same durable lease used by the worker; it must not
call the computer and acquire a database advisory lock afterward.

Adoption protocol (adapted to Pi's synchronous append ordering):

1. acquire the context-session lease;
2. reopen current JSONL and archive manifest;
3. verify captured prefix digest and archive sequence;
4. atomically write a durable intent containing the validated archive input;
5. let Pi synchronously append its compaction entry carrying the compaction ID;
6. write the content-addressed blob and atomically replace the manifest from
   the matching intent;
7. remove the intent after the authoritative manifest is durable;
8. emit an idempotent `context.compacted` event keyed by compaction ID;
9. upsert `ContextCompaction`, set epoch to the archive sequence, and refresh
   projections in one PostgreSQL transaction;
10. release the lease.

If the process crashes after the Pi append but before manifest adoption, the
next context-state preflight finds the matching Pi entry and replays the intent.
If Pi never appended, preflight discards the unmatched intent. A crash after the
manifest but before intent unlink is idempotent. The manifest epoch advances
only for a matching persisted Pi compaction, and duplicate events remain safe by
compaction ID.

Never use `turnId` as compaction identity. One turn may produce overflow recovery
and a later threshold summary.

## Prompt reconstruction and file-backed state

At adoption time, reuse the exact captured system object and optional user-info
object. Do not reread mutable files halfway through adoption.

On the next ordinary turn:

- rebuild current system and user-info through the normal prompt collector;
- retain the adopted summary and last user message;
- use the manifest epoch to refresh the frozen profile, memory, and skill
  snapshots exactly once;
- append an identity-change announcement once per epoch when profile name or
  description changed;
- preserve first-fact memory behavior: an empty memory snapshot may gain its
  first fact before the next epoch, then freezes;
- reload automations, channels, active skills, user memory, project memory, and
  current tool catalog using their documented refresh rules;
- never treat a summary as curated memory or write summary prose into `memory/`.

Split platform prompt generation into a stable system message and an explicitly
tagged user-info message so the compaction partition is deterministic. Add a
golden prompt-envelope test for DM, group, A2A, routine, bootstrap, and subagent
wakes.

## Conversation-size guard

Implement byte accounting separately from token compaction.

- soft limit: 256 MiB per context session;
- hard limit: 1 GiB per context session;
- configuration overrides are explicit deployment settings;
- soft-limit GC removes unreachable/orphan archive blobs and safe obsolete
  runtime branches, never the visible PostgreSQL transcript or current archive;
- hard-limit failure is fail-closed, reports a stable error code, and asks the
  user to start a new conversation/context only when GC cannot recover enough;
- GC is lease-protected, restart-safe, and dry-run testable.

Because OpenBot currently exposes one home conversation per Bot, the product
needs a separate design before offering a user-visible New conversation control.
The size guard must not silently create a new Bot.

## Manual and UI behavior

Strict parity means there is no user-facing Compact button, slash command,
working-set meter, archive tab, undo action, or New session control.

- remove the desktop client method if unused;
- remove or restrict the server manual compact route to test/admin builds;
- keep a test-only forced trigger behind dependency injection, not a production
  HTTP endpoint;
- retain internal telemetry for starts, adoption, stale discard, retry, and
  failure;
- do not render a visible “Context compacted” transcript row unless a later live
  Grok UI probe proves one exists.

The full transcript remains available to normal history/search/export paths.
Summary archive contents are internal implementation state, not a user-visible
replacement transcript.

## Delivery phases

### Phase 0 — freeze the contract

- check in redacted golden fixtures derived from the compaction audit;
- encode trigger formulas, message partition, wrapper shape, reason enums, and
  scope mapping as tests before implementation;
- record remaining unknowns instead of guessing: live `supportsSelfSummary`,
  successful live `summaryArchives` decode, exact compact-time user-info rerender,
  and any user-visible progress/error notice.

Exit: contract tests fail against the current Pi behavior for the expected
reasons.

### Phase 1 — context-session identity

- add `ContextSession` and migrate existing Bot session references to home;
- route home, group, routine, A2A, bootstrap, and subagent wakes to the correct
  context key;
- preserve existing sessions without transcript loss;
- keep compaction/session state per context while retaining the conservative
  Bot-scoped execution lease until same-Bot parallel-turn behavior is
  source-verified.

Exit: two group rooms and the home DM advance independent session/archive
epochs; routines return to home; no context is selected by an unsafe file check.

### Phase 2 — durable archive and reconciliation

- implement content-addressed blobs and atomic manifest replacement;
- add `ContextCompaction` projection and stable compaction IDs;
- reconcile manifest to PostgreSQL on session open and startup;
- change snapshot epochs to the reconciled context archive sequence;
- make event and RunItem projection idempotent by compaction ID.

Exit: crash injection at every adoption step converges to one archive, one epoch,
one event, and at most one projection row.

### Phase 3 — summarizer engine

- implement deterministic partition/serialization;
- implement isolated no-tool summary inference;
- add three-attempt retry, 2-second transient backoff, input reduction, output
  validation, abort, usage capture, and recursive summary consolidation;
- implement the OpenBot-authored summary wrapper and `isSummary` tag.

Exit: golden model-prefix tests match the recovered Grok contract for text,
tools, attachments, an existing summary, and a split/oversized turn.

### Phase 4 — coordinator and automatic triggers

- disable Pi default compaction for parity sessions;
- add background start/persist thresholds;
- add 90%, 1,000-turn, 85-image, proactive-limit, and provider-overflow gates;
- add exact-prefix stale checks and blocking one-retry overflow recovery;
- retain only bounded in-flight coordinator state.

Exit: automatic compaction occurs without a manual endpoint, does not interrupt a
normal turn, and overflow recovery blocks and retries exactly once.

### Phase 5 — prompt and scope parity

- preserve the stable system snapshot and support the optional tagged user-info
  envelope when one is present;
- reconstruct the compacted prefix through the Pi `context` hook;
- refresh file-backed snapshots on the reconciled archive epoch;
- complete per-home/per-group routing and origin fixtures;
- verify prior summary consolidation rather than unbounded wrapper nesting.

Exit: model-facing captures for every wake origin match the contract while the
visible transcript remains unchanged.

### Phase 6 — size GC and production surface

- implement soft/hard byte limits and safe GC;
- remove or gate manual compact APIs and unused client methods;
- hide the current user-visible compaction RunItem while retaining telemetry;
- add metrics, structured logs, and health diagnostics.

Exit: size-limit tests are deterministic, and production exposes no manual
compact primitive.

### Phase 7 — migration and rollout

- ship schema/storage readers before writers;
- reconcile all existing sessions and report drift without mutating them;
- canary the new policy on disposable Bots, then newly created Bots;
- migrate existing Bots after backup and dry-run checks;
- keep a reversible feature flag that reads the new archive but can temporarily
  fall back to Pi context reconstruction before any new archive is adopted;
- remove the fallback only after the full release gate passes.

Exit: every active context has consistent archive/database epochs and no lost
visible or model-facing history.

## Test matrix

Unit tests:

- token, percent, turn, image, and overflow trigger boundaries;
- system/user-info/last-user partition and synthetic-user exclusions;
- tool-call/result pairing, hidden prompts, attachments, and earlier summaries;
- retry classes, empty output, reduced input, abort, and stale-prefix handling;
- archive manifest validation, missing blob rejection, orphan cleanup, and epoch
  monotonicity;
- byte accounting and soft/hard GC decisions.

Integration tests:

- background start remains non-blocking;
- mid-loop persist requires both threshold and prefix equality;
- overflow summary blocks and retries the interrupted turn once;
- two compactions in one turn produce two distinct IDs without projection
  collision;
- crash after every adoption step reconciles on restart;
- concurrent user turn, group wake, routine, and summary adoption serialize on
  the correct context lease;
- profile/memory/skill snapshots refresh after adoption while automations,
  channels, and current catalog reconstruct correctly;
- home and two group contexts compact independently;
- full transcript remains searchable/exportable and is never pruned by token
  compaction;
- 256 MiB/1 GiB behavior is tested with sparse fixtures rather than allocating
  giant in-memory payloads.

Live disposable-Bot gates:

1. Force a small test model window through dependency injection; do not spend a
   real 272k-token window.
2. Observe background start, later adoption, unchanged visible transcript, exact
   reconstructed prefix, archive blob, manifest epoch, database projection, and
   snapshot refresh.
3. Restart the computer between manifest commit and database projection and
   verify reconciliation.
4. Run independent home and group compactions for one disposable Bot.
5. Trigger one classified provider-overflow fixture and verify blocking retry.
6. Delete the disposable Bot and verify context-session storage follows the
   intended deletion/orphan policy.

## Observability

Emit metrics and structured logs for:

- background starts, completes, adopts, stale discards, failures, and aborts;
- blocking overflow summaries and successful/failed retries;
- attempt count, latency, tokens before/after, image count, turn count, and
  summary size;
- manifest/database drift and reconciliation;
- per-context bytes, GC reclaimed bytes, and hard-limit failures;
- active coordinator count and eviction.

Never log raw protected prompts, complete summaries, attachment bytes, secrets,
or verbatim tool outputs. Diagnostic records use IDs, digests, sizes, reasons,
and redacted error classes.

## Release gate

Strict parity is complete only when all of the following are true:

1. The exact Grok trigger formulas and gate boundaries pass deterministic tests.
2. Captured model input after adoption is exactly system, optional user-info,
   last user, and `isSummary` user message.
3. Normal background work does not block or interrupt the active turn.
4. Overflow recovery blocks and retries once without duplicating a user message
   or tool result.
5. Stale summaries never advance archive state or prompt epochs.
6. Archive adoption is restart-safe and database projection self-reconciles.
7. Multiple compactions in one turn and concurrent origins cannot collide.
8. Home/group/routine/A2A/subagent scope matches the frozen routing contract.
9. Full transcript history/search/export remains intact.
10. File-backed profile, settings, memory, skills, automations, channels, and
    identity-announcement behavior survives compaction and restart.
11. The soft/hard byte guard works without deleting the current transcript or
    adopted archive.
12. Production exposes no unsupported manual Compact or archive UI.
13. Existing sessions migrate without transcript loss, epoch drift, or model
    context regression.
14. Computer, worker, server, messaging, database, and desktop test suites,
    typechecks, and production builds pass.

## Small remaining Grok probes

These improve confidence or close dependency-level deltas; they do not justify
guessing in application code:

- decode one live typed Grok `ConversationState` root read-only to confirm
  `summaryArchives.length` and `selfSummaryCount`;
- read the live `supportsSelfSummary` capability for the selected Grok model;
- observe whether Grok displays any progress/error notice during that throwaway
  adoption;
- confirm the exact retry-directive categories and durable-block ordering from
  the pending Grok source reply once the Grok Bot app can be read again;
- add the five-iteration overflow model/tool-step loop and summary-time tool
  schemas in a maintained Pi dependency, then run a forced provider-overflow
  probe.

No real Bot should be driven to the context limit for these probes.
