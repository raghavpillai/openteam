# Grok context-compaction parity — implementation validation

Date: 2026-08-28
Scope: local OpenBot Compose stack; disposable Bot and group only

> Historical evidence notice (2026-08-28): the live probes below accurately
> describe the implementation that was tested at the time, but a later read-only
> Grok host-bundle audit rejected the old group-scoped context, `turn_limit`
> persistence, exact-length stale check, summary timeout, and archive redaction.
> Do not treat those historical claims as the current Grok contract. The source
> correction and replacement validation appear at the end of this report.

## Result

HISTORICAL PASS. The tested implementation created independent home/group runtime
contexts, adopted a real automatic compaction, projected one stable archive to
PostgreSQL, reconstructed it after a computer restart, kept compaction invisible
in chat, and removed all scoped files when the disposable Bot was archived.

## Static and deterministic verification

- `bun run check`: passed all workspace typechecks, package tests, and builds.
- Focused compaction/runtime tests: 35 passed.
- Messaging filesystem/prompt tests: 44 passed.
- Context prompt-snapshot PostgreSQL integration test: passed.
- A fresh disposable PostgreSQL database applied all 19 migrations in order.
- The same snapshot integration test passed against that fresh schema.
- Biome checks passed for the new/changed compaction implementation files.

Covered deterministic behavior includes:

- 10,000-token-or-10% background threshold;
- 5,000-token-or-5% persist threshold and Pi's strict-boundary adjustment;
- non-blocking background generation;
- three attempts, two-second production backoff, input reduction, empty-output
  rejection, timeout/abort handling, and system/message stale checks;
- last-user preservation, tagged and epoch-stable user-info replacement,
  prior-summary consolidation, image counting, and image-byte redaction;
- exact message-value stale rejection: newly appended content invalidates and
  regenerates a background result rather than becoming a post-capture tail;
- content-addressed blobs, durable intent replay across the Pi-append/manifest
  crash window, atomic/fsynced manifest replacement, strict metadata/digest
  checks, orphan collection, and 256 MiB / 1 GiB guards;
- exact epoch reconciliation, stable IDs, idempotent projection, and no visible
  compaction RunItem;
- independent profile/memory/skill snapshots per context epoch.
- frozen fact-bearing memory remains frozen after raw file removal, while the
  official forget path intentionally invalidates every context snapshot.

## Live disposable-Bot verification

The probe used one newly created Bot named `Compaction Parity Probe` and one
newly created group named `Compaction Parity Probe Room`.

1. A home request returned `HOME_CONTEXT_OK`.
2. A group request returned `GROUP_CONTEXT_OK`.
3. PostgreSQL and Pi files showed two different immutable context/session IDs
   and two different JSONL paths. Both began at epoch 0.
4. The computer service restarted. A home follow-up returned
   `HOME_RESTART_OK` from the same home session.
5. The disposable group JSONL received 998 minimal synthetic user entries,
   bringing its effective user-turn count to exactly 1,000 without touching any
   real Bot.
6. The next group wake automatically compacted before the prompt and returned
   `GROUP_COMPACTION_OK`.
7. The adopted record had:
   - reason `turn_limit`;
   - epoch/sequence 1;
   - turn count 1,000;
   - one UUID archive ID;
   - matching prefix and summary digests in PostgreSQL and the manifest;
   - one Pi JSONL `compaction` entry with the OpenBot extension details;
   - one content-addressed blob referenced by the atomic manifest.
8. The home context remained epoch 0, proving group adoption did not advance
   home state.
9. The visible transcript retained the normal user/agent messages and contained
   zero compaction RunItems.
10. The computer restarted again. The group continued from the persisted
    archive and returned `GROUP_ARCHIVE_RESTART_OK` using the same session ID and
    path; the archive remained epoch 1.
11. The public manual compact route returned HTTP 404.

## Migration repair caught by the probe

The first live wake found a development-schema drift: the context-session and
compaction tables existed, but `ContextPromptSnapshot` was absent even though an
earlier evolving migration had been recorded as applied. The idempotent
`20260828000300_context_prompt_snapshot_repair` migration now converges both
that development state and fresh databases. The probe was repeated only after
the repair applied successfully.

## Cleanup

- The disposable Bot was archived through the public API.
- Its agent-data directory, both Pi JSONL session files, and both context archive
  directories were verified absent afterward.
- Because OpenBot does not expose a public group-delete API, the exact disposable
  group row and its exact agent-data/workspace directories were deleted after a
  read-only target check.
- The client snapshot reported zero matching probe Bots and zero matching probe
  groups.

These deletions are intentional and not recoverable. No pre-existing Bot,
memory, routine, skill, group, session, or archive was mutated by the probe.

## Not forced live

The real 272k-token background/persist boundary and a provider-generated
context-overflow error were not forced because doing so would spend substantial
tokens for no additional implementation coverage. Their formulas and state
transitions are deterministic tests; overflow compact-and-retry is supplied by
the pinned Pi session lifecycle and OpenBot's custom compaction hook. The
1,000-turn live trigger exercised the same generate/adopt/persist/reconstruct
path with a bounded disposable fixture.

## Follow-up source-audit correction

A subsequent reconciliation against the Grok host-bundle report found that the
first implementation had mixed in two behaviors from the bundled but unused
`XaiCompactionHandler`: synthetic-acknowledgement filtering and its
`<conversation_summary>` wrapper. Grok Bot wires `SelfSummarizer` instead.

The implementation now follows the active path: it peels user-info only from a
leading user/user pair, preserves `findLastUserMessageIndex` semantics, supplies
the original messages to an isolated summarizer as structured history, emits
the `<summary_content>` / self-summary-count wrapper, and reconstructs a stable
summary timestamp across turns. Archive epoch remains monotonic while the
separate wrapper count resets at each new user query, as the host source does.
Focused compaction, routing, projection, and prompt-snapshot tests pass after
the correction. A fresh external Grok audit is still pending authenticated
access.

## Corrected SelfSummarizer live probe

After rebuilding the computer service, a second disposable Bot named
`SelfSummary Parity Probe` exercised the corrected path:

1. A baseline model turn returned `SELF_SUMMARY_BASELINE_OK`.
2. Exactly 998 minimal user entries were appended to that disposable Pi JSONL,
   bringing its user-role count to 1,000.
3. The next request completed through a real `turn_limit` summary and returned
   `SELF_SUMMARY_CORRECTED_OK`.
4. The adopted archive was epoch/sequence 1 with `selfSummaryCount: 1`, exactly
   1,000 counted turns, matching manifest/PostgreSQL digests, one referenced
   content-addressed blob, and one Pi compaction entry carrying the same stable
   compaction UUID.
5. The blob preserved the final user-role message according to
   `findLastUserMessageIndex` semantics. The normal visible transcript had no
   compaction RunItem.
6. A new user query returned `SELF_SUMMARY_RESET_OK`; the manifest retained
   epoch/archive count 1 while resetting `selfSummaryCount` to 0.
7. After restarting the computer service, the same context reconstructed from
   the archive and returned `SELF_SUMMARY_RESTART_OK`; epoch and projected row
   count stayed 1.

The disposable Bot was then archived through the public API. Its sidebar row,
DM channel, Pi JSONL, and context-archive directory were verified absent. The
archive operation is intentional and not recoverable; no pre-existing Bot or
file was changed.

## Second adversarial audit and user-info live probe

A later source-to-code audit found and fixed additional implementation defects:

- a background summary was accepted after appended messages; adoption now
  requires exact message-value equality and regenerates stale work;
- failed/deleted compactions retained captured history, retry reduction could
  split multi-call tool exchanges, aborts during retry delay surfaced the prior
  transient error, and setup races could open one context twice;
- Pi appends its compaction entry before the extension success callback. A
  durable intent now bridges that crash window and is replayed only when the
  matching Pi compaction ID is on the current branch;
- manifest/blob metric and timestamp validation was incomplete, atomic-write
  failures could leave temp files, and best-effort background observation could
  reject without a handler;
- runtime preflight now reconciles archive state before prompt snapshots are
  collected, including after restart and rolling-deployment fallback;
- raw deletion of the final memory fact no longer bypasses a fact-bearing frozen
  snapshot; official forget still invalidates it immediately;
- saved-skill bodies are no longer copied into the prompt catalog. The model gets
  a tagged, epoch-stable `user_info` entry containing only skill name,
  description, and `SKILL.md` path.

The rebuilt Compose stack then used disposable Bot
`517293aa-480c-4bbc-a05c-cd6c8bf677ff` and context
`b8722cfa-3cb3-4279-891b-c4d18b4d0f43`:

1. The Bot officially created `User Info Proof`, whose body contained a unique
   private marker.
2. A 1,000-effective-user-turn fixture adopted archive 1 and returned
   `USER_INFO_COMPACTION_OK`.
3. As expected, archive 1 retained epoch-0 user-info because the skill was added
   mid-epoch.
4. After the epoch refresh, another 1,000-turn fixture adopted archive 2 and
   returned `USER_INFO_EPOCH_ONE_OK`.
5. Archive 2's tagged user-info had `userInfoSummarizationEpoch: 1`, contained
   the skill name and exact `user-info-proof/SKILL.md` path, and did not contain
   the skill-body marker.
6. Both archives had `turn_limit`, exactly 1,000 turns, contiguous sequences,
   matching PostgreSQL rows, and no leftover `compaction.intent.json`.
7. After restarting the computer, the same context returned
   `USER_INFO_RESTART_OK` without advancing epoch 2.
8. Archiving the disposable Bot removed its sidebar row, agent-data directory,
   Pi JSONL, and complete context-archive directory.

The full repository `bun run check` passed after these fixes. A fresh disposable
database again applied all 19 migrations, and the prompt-snapshot integration
test passed with 30 assertions, including raw-removal freeze, official-forget
invalidation, and metadata-only skill catalogs.

## Source-validated replacement result

The installed Grok Bot was queried through the app, source-first and read-only.
Its later corrections supersede the older live-probe interpretation:

- the 1,000-turn gate starts background summarization with
  `approaching_token_limit`; by itself it never persists or blocks;
- group-member execution uses the member Bot’s home session while room history
  remains a separate transcript;
- an appended suffix is valid. Grok compares the captured prefix by message
  value and only restarts when that prefix changes;
- completed background work can be adopted before the next model step at the
  90% start threshold. End-of-turn adoption still requires 95%/5k or 85 images;
- self-summary generation uses three attempts including the first with 2-second
  transient delays and no summarizer-specific deadline;
- persisted archives retain serialized image/reasoning/tool payloads and omit
  prior `isSummary` rows;
- the summary carrier includes durable project/transcript pointers and the last
  real user’s manually attached skill block.

OpenBot was corrected accordingly. Deterministic validation now covers:

- turn-only background start with no model-context projection or archive;
- incoming-user capture, prefix-value invalidation, appended-suffix retention,
  and 90% between-step projection;
- `self_summary_completed`, image, and overflow reason precedence;
- durable block rendering and restart reconstruction;
- full serialized archive payload retention;
- sealed failed-overflow assistant retention before the successful retry; and
- group-member routing to each Bot’s home context.

The prior 1,000-turn live fixtures cannot validate persistence because the
source proves that gate is start-only. Replacement live validation must force an
85-image boundary, a real 95%/5k boundary, or a provider overflow on a disposable
Bot. No real Bot state is required for that probe.

## Replacement 85-image E2E probe

Date: 2026-08-28. Scope: disposable Bot only.

- Bot: `b5b68b20-b988-4d5f-921f-edbcf7f3baed`
- conversation: `9e1e08c1-b150-4e47-85aa-b746ef0d8844`
- context/runtime session:
  `1a9ba5c1-7e07-43f4-a862-e823d3ab9f62`
- Pi JSONL:
  `/home/openbot/.pi/agent/sessions/openbot/2026-08-28T09-40-45-104Z_1a9ba5c1-7e07-43f4-a862-e823d3ab9f62.jsonl`

### First boundary: regression discovery

Eleven sequential real model turns supplied 85 tiny PNGs. The first archive
adopted with `approaching_image_limit`, but the archive summary was only
`Acknowledged.`. The summarizer had obeyed the disposable Bot's normal
acknowledgement instruction instead of performing the compaction task.

The first post-restart turn also failed with an orphaned function-call output.
Inspection showed the background prefix ended on the assistant `SendToUser`
call while `preservedTailMessages` started with its `toolResult`. This was a
real capture-boundary bug, not a synthetic unit fixture.

Two repairs followed:

1. the summary-only system context now makes the normal agent system prompt
   subordinate data and forbids acknowledgement, normal task response, and tool
   execution during summary generation;
2. preserved suffixes close over tool-call owners and sibling results, with the
   same repair applied during reconstruction of older archives.

Focused validation after the repair: 39 compaction tests passed, including
mid-loop/multi-call boundary closure and legacy archive reconstruction. The
exact broken archive then resumed successfully without being rewritten.

### Second boundary: corrected result

The continued disposable session reached 85 model-context images again and
adopted archive `8e39de06-9513-45e1-8ffe-ab02cccca2e6`.

- manifest epoch/archive count: `2` / `2`;
- reason: `approaching_image_limit`;
- `imageCount`: `85`; `turnCount`: `11`;
- `piBaseMessageCount`: `2`;
- summary: substantive continuation state covering the probe goal, constraints,
  attachment identities, completed turns, and pending behavior (not an ack);
- durable blocks: escaped `project_root` and the exact Pi
  `transcript_location` pointer;
- `summarizedMessages`: 39 serialized messages with 77 image parts; the last
  user retained the other 8 images verbatim;
- preserved suffix roles: `assistant`, `toolResult`, `assistant`, with one call,
  one matching result, and zero orphan result IDs;
- no `compaction.intent.json`; manifest and content-addressed blob only.

PostgreSQL projected contiguous adopted sequences 1 and 2. The
`ContextSession` row reported epoch 2 and archive 2 as `lastArchiveId`.

The computer service was restarted once. A no-image follow-up completed with
`Acknowledged.`, reused the same runtime-session ID and Pi JSONL path, and did
not advance epoch 2. The full repository `bun run check` then passed.

### Validation boundary

This proves the real image trigger, summary inference, atomic archive files,
database projection, tool-boundary repair, restart reconstruction, and continued
model execution. It does not force a provider token-overflow. The pinned Pi
harness still exposes one overflow compact-and-retry rather than Grok's separate
five-iteration model/tool-step budget loop; that remains a dependency-level
delta, not a claim of parity.

## Live installed-Grok 256k token compaction probe

Date: 2026-08-28. Scope: one newly created disposable Grok Bot named
`Compaction Live Probe 20260828`. No existing Bot, memory, routine, skill, or
file was mutated.

### OBSERVED

- The pre-compaction typed root decoded as
  `agent.v1.ConversationStateStructure` from `conversation-blobs.db` through
  `sand-live-conversation-root-v1__`.
- Baseline state was `94,233 / 256,000` tokens, archive count 0,
  `selfSummaryCount=0`, no `isSummary` message, and
  `summarized_conversation=0`.
- After the first controlled 234,205-character context block the live root was
  `197,785 / 256,000`; archive count remained 0.
- After the second controlled 104,214-character block and a read-only
  checkpoint the live root was `242,334 / 256,000`; archive count remained 0.
  This was 866 tokens below the 95% boundary of 243,200.
- A final 9,000-character labeled block crossed the persistence boundary. The
  next decoded root was `55,138 / 256,000`, archive count 1,
  `message_count_at_last_compaction=13`, and exactly one message with
  `providerOptions.cursor.isSummary=true`.
- `ConversationSummaryArchive` decoded with fields
  `1 summarized_messages`, `2 summary`, `3 window_tail`, and
  `4 summary_message`. The live archive held 87 summarized message blobs and a
  9-message window tail; the reconstructed root held 51 prompt-message refs.
- All 87 archived message blobs and all 11 then-current turn blobs still
  existed. The three large `CONTEXT_FILL` bodies remained in the blob store and
  every pre-compaction message remained visible and scrollable in the UI.
- The visible UI showed ordinary Working/replied state only. It displayed no
  compaction notice, progress card, archive inspector, transcript replacement,
  or undo affordance.
- The post-compaction agent recalled all three pre-compaction anchors exactly:
  `ultraviolet`, `731944`, and `copper-orbit-lantern`.
- The actual persisted summary carrier for this ordinary Grok Bot contained
  transcript and todo trailing blocks. It contained no project-root or
  `<system_reminder>` block because field 33
  `is_root_project_conversation` was absent.
- The compaction trigger reason was not persisted in
  `ConversationSummaryArchive` or `ConversationState`; it was used by
  `handleSummarization` for metrics/log labels.

### SOURCE-VERIFIED

- Background summarization begins at
  `min(maxTokens - 10,000, maxTokens * 0.90)`. Persistence uses
  `min(maxTokens - 5,000, maxTokens * 0.95)`.
- A completed between-step summary is appended to `summaryArchives` and
  persisted before the next model call uses the reconstructed prompt. The
  archive epoch therefore advances before that call; user-info rerender waits
  for the next `initializeConversation`.
- A real new user query calls `resetSelfSummaryCount()` from `createAgentTurn`
  when `userMessage.isSimulatedMsg !== true`. This explains why the audit turn
  observed proto-default 0 after the prior compaction even though archive epoch
  stayed 1.
- `executeSelfSummaryStream` has no explicit per-attempt or overall timeout.
  The related constants are `MAX_SELF_SUMMARY_RETRIES=3` and
  `TRANSIENT_SELF_SUMMARY_RETRY_DELAY_MS=2000`.
- Empty summary output retries immediately with the same full inputs. It does
  not delay, reduce inputs, or request shorter output.
- Thrown errors use the source retry classifier: output-token errors delay,
  reduce, and request shorter output; input-too-large/token-limit errors reduce
  immediately; resource exhaustion/unavailable/rate-limit and uncategorized
  `Error` instances use the transient delay; abort, invalid JSON, ordinary
  invalid argument, unauthenticated, not found, closed-listener, cannot-truncate,
  and non-`Error` throwables do not retry.
- The project-root slot exists in the summarizer layout, but
  `projectRootPrompt` is populated only for a root-project conversation.
  Ordinary Grok Bots render no block there.

### OPENBOT CORRECTIONS FROM THIS PROBE

- Mid-loop adoption now commits the content-addressed archive and emits its
  stable projection event before returning the compacted messages for the next
  model call. It no longer waits until end-of-turn to advance the epoch.
- The old Pi/session transcript remains append-only and visible; OpenBot's
  archive stores the summarized payloads and reconstructs only the reduced model
  prefix, matching the observed Grok separation between history and prompt.
- Summary retry classification now matches the source matrix. Empty output has
  its own immediate, same-input path; non-retryable error classes stop on the
  first failure.
- Project-root is now gated by an explicit root-project flag and rendered as a
  system reminder only in that mode. Ordinary Bots omit it.
- The structured durable todo snapshot now crosses the worker/computer boundary
  and is included in the summary carrier alongside the transcript pointer.
- Focused compaction/routing/projection validation passed 52 tests. The complete
  workspace `bun run check` passed typecheck, all package tests, and all builds.

### INFERRED

- The persistence transition happened after the small threshold-crossing block
  and before the next audit model call. The exact first durable-write instant
  was not sampled between those two UI actions, but the live token collapse,
  source ordering, archive metadata, and next-call behavior agree.
- Grok's lack of a visible compaction card is deliberate UI transparency rather
  than a rendering race: the source exposes no user-facing manual compact,
  archive inspection, or undo surface, and the entire live transition completed
  without one.

### UNKNOWN / INTENTIONAL REMAINING DELTAS

- A real provider overflow was not forced live. OpenBot's pinned Pi harness
  still exposes one compact-and-retry where Grok's surrounding loop permits up
  to five model/tool-step iterations after an overflow.
- Grok supplies the normal tool schemas to the isolated SelfSummarizer but
  executes none (`executeModelStreamOnly`). OpenBot's isolated summary session
  supplies no tool schemas, also executes none, and is behaviorally safer but
  not request-shape identical.
- OpenBot uses its own JSON/content-addressed archive files and PostgreSQL
  projection rather than Grok's protobuf `ConversationSummaryArchive` inside
  `conversation-blobs.db`. The tested lifecycle semantics now match; the bytes
  and storage engine intentionally do not.
- The disposable Grok Bot remains in the Grok Bot sidebar pending explicit
  confirmation for permanent deletion.

## Second adversarial source/app pass

Date: 2026-08-28. Scope: the existing disposable Grok Bot and a read-only
OpenBot source-to-runtime trace. No real Bot, memory, routine, skill, or file was
mutated.

### OBSERVED

- The disposable Grok Bot completed a six-part source audit and a focused
  follow-up in the app. It reported the model-facing wake mapping, live todo
  capture, automation-trigger extraction, persistence/crash order,
  provider-overflow retry path, carrier ordering, and summary-time tool-schema
  handling.
- The follow-up explicitly covered successful, error, aborted, and unspecified
  background-task completions and separated the routine wake text from cached
  `<automation_trigger_info>`.
- OpenBot focused validation passed 75 tests after the corrections. The full
  workspace `bun run check` passed typecheck, all package tests, and all builds.

### SOURCE-VERIFIED

- `createAgentTurn` calls `resetSelfSummaryCount` exactly when
  `userMessage.isSimulatedMsg !== true`. `assembleTurnAction` in
  `../packages/grok-bot-harness/src/runner/turn-run-shell.ts` constructs routine,
  A2A, group, hidden reply-nudge, and upgrade-resume messages without the flag,
  so all reset. A Task child's first prompt also resets its own counter.
- `BackgroundTaskCompletionActionHandler.prepareFollowupTurn` in
  `../packages/agent/dist/actions/background-task-completion-action-handler.js`
  constructs `isSimulatedMsg: true` with
  `SimulatedMsgReason.BACKGROUND_TASK_COMPLETION` for success, error, aborted,
  and unspecified completion statuses. These parent follow-ups do not reset the
  parent's count.
- `SummarizationOrchestrator` snapshots `stateHandler.todos` when
  `summarizer.summarize()` starts, then applies `formatTodosForSummarization`,
  `pruneFinishedTodos`, and `MAX_FINISHED_TODOS=50`. It is not a turn-start
  snapshot, and later TodoWrites do not retroactively change an already-running
  summary.
- `getAutomationTriggerContext` uses
  `extractAutomationTriggerContext` to cache the first complete tagged block.
  `buildAutomationWakePrompt` in
  `../packages/grok-bot-harness/src/automations/automation.ts` does not itself
  write those tags. Same-stream retries reuse the original user-message bytes;
  a new fire rebuilds the wake and may re-slice the original live message.
- `handleSummarization` writes archive blobs, pushes the in-memory archive,
  rewrites the root prompt, increments the summary count, and only later relies
  on `computeNewStructure` plus `persistCheckpoint` / `handleCheckpoint` for a
  durable root. A process crash after the in-memory push but before checkpoint
  loses that adoption on restart. `enqueueExclusiveRun` serializes the session;
  `host.runGeneration() !== generation` rejects late checkpoints.
- `runWithSummarizationRetry` in
  `abstract-user-message-action-handler.js` has five outer model/tool-step
  iterations. `InputTokenLimitError` still seals the failed assistant, and
  `messagesNotSummarized = allMessages.slice(messagesSummarized.length)` keeps
  that record when it falls after the summarized prefix. There is no dedicated
  pop/removal.
- Archive field order is not prompt order. The live prompt is system, optional
  user-info, preserved last real user, one `isSummary` carrier, then
  `messagesNotSummarized`. Within the carrier, mode/custom/project-root blocks
  lead; transcript/todos/automation/skills trail. `window_tail` is archive
  metadata, not a separately injected prompt message.
- `SelfSummarizer.generateSummary` passes ordinary tool schemas through
  `executeSelfSummaryWithRetry` / `executeSelfSummaryStream` to
  `executeToolStream`. Unexpected calls are counted but not executed. Schemas
  are request metadata rather than summary-input text, but their tokens affect
  usage accounting.

### OPENBOT CORRECTIONS FROM THIS PASS

- The worker now distinguishes normal/hidden wakes from simulated background
  completion wakes. Direct A2A, group, routine, retry, child-task, and
  child-resume turns reset the per-query count; parent completion/failure/stop
  continuations do not.
- A successful in-turn `TodoWrite` refreshes the computer runtime's durable todo
  snapshot. A summary that begins afterward sees the latest list, while a
  summary already running retains its start-time snapshot.
- Scheduled routine wake text is unchanged. Its tagged automation trigger is a
  separate, immutable inbox payload carried into the summary request, so worker
  retries reuse it byte-for-byte without turning the ordinary wake into a
  tagged message.
- Overflow reconstruction now retains the sealed failed assistant before the
  successful retry, matching `consumeStream` and `messagesNotSummarized`.
- Root-project reminders now precede summary content inside the carrier;
  transcript, todo, automation, and attached-skill blocks remain trailing.
- New request-contract, wake-routing, todo-refresh, routine-trigger,
  overflow-tail, per-query-count, and carrier-order tests cover these paths.

### INFERRED

- Treating OpenBot `subagent.failed`, `subagent.stopped`, and
  `subagent.cancelled` parent wakes as the same simulated completion class is
  the direct analogue of Grok's status-independent
  `BACKGROUND_TASK_COMPLETION`. OpenBot currently emits completion and failure
  wakes; the stop/cancel names are guarded for future emitters.
- OpenBot's fsynced manifest commit before a mid-loop model call is deliberately
  stronger than Grok's in-memory-before-checkpoint crash window. The normal
  prompt result is the same; only a process crash inside that narrow interval
  differs.

### UNKNOWN / INTENTIONAL REMAINING DELTAS

- A provider-generated overflow has still not been forced in either disposable
  implementation during this pass. The failed-assistant rule is source-backed
  and deterministically tested.
- The pinned Pi harness still owns a single overflow compact-and-retry rather
  than Grok's five outer model/tool-step iterations.
- OpenBot's isolated summarizer still omits ordinary tool schemas. Closing that
  request-shape and token-accounting delta without executing tool calls requires
  a maintained Pi/provider hook rather than an application-level fake tool.
- OpenBot intentionally keeps stronger durable adoption across the
  in-memory/checkpoint crash window and uses JSON/PostgreSQL rather than Grok's
  protobuf blob store.
