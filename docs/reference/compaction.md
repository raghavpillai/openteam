# Compaction

Compaction summarizes older conversation context so a bot can keep working within the model's context window. The original transcript remains on disk. For the distinction between chat history and saved facts, see [Memory](../usage/memory.md#long-conversations).

OpenTeam implements the generic self-summary behavior inspected in Grokbot's `ecc8113` and `886e13a` box hosts. It does not load the recovered host bundle. The dated investigations below document compatibility checks and their limits.

A summary is generated through a separate, non-tool-executing provider request. The main agent can continue while it runs. Starting generation, completing generation, and adopting a summary are separate operations.

## Request and replacement

The summarizer receives the original system prompt, optional trusted user information, the complete settled conversation history, and Grokbot's generic summary request. The latest non-summary user request is included in that history and also preserved verbatim in the replacement. Only assistant messages with zero-length string or array envelopes are omitted from generation; whitespace, empty text parts, and signed thinking parts are retained. Previous summaries remain available to generation but are never selected as the latest user request.

After adoption, the effective model context contains user information, the preserved request, a marked user-role summary carrier, and everything appended beyond the captured prefix. Original raw messages remain in the Pi transcript and summary archives. The system prompt is managed separately by Pi.

Transcript location, current todos, automation context, and all attached skill blocks are carried outside generated prose. Skill extraction matches exact lowercase tags within each user text segment. Todos and automation retain the generic reference's explanatory text. Successful summary text keeps its whitespace, joins nonempty text parts with newlines, and removes closed legacy `<think>` blocks before entering the reference carrier. Every runtime entry point uses the same context builder. A root-project reminder is supported when the caller identifies a root project; ordinary OpenTeam bot requests currently do not identify one. Grokbot's separate mode/custom-mode project model is not invented for OpenTeam.

## Timing

For context window `W`, the default background threshold is `min(W - 10,000, 0.90 × W)`. The persistence threshold is mathematically `min(W - 5,000, 0.95 × W)`. Boundaries are inclusive; persistence executes the reference's remaining-token arithmetic, preserving even its floating-point behavior on fractional diagnostic inputs. There is no independent 1,000-user-message trigger.

The active generic orchestrator also launches when usage reaches `floor(0.90 × W)`. For windows that are not multiples of ten, that self-summary condition can start generation one token before the background gate permits mid-loop adoption. Persistence and stored-adoption checks continue to use their own background predicates.

A valid provider early-compaction threshold can lower both boundaries after reported input usage reaches it. A threshold must be a positive safe integer below the context window. The runtime consumes the explicit `earlyCompactionContextTokenThreshold` field when a provider exposes it on streamed/final assistant messages, and resets that metadata for each request. Standard Pi adapters do not currently guarantee that field; they use the default policy. No undocumented response header is assumed.

Usage delivered during streaming can launch a summary of the settled request prefix before the assistant finishes. The partial assistant message itself is not captured. Completion also provides an observation point for providers that report usage only at the end.

A completed candidate may be adopted between requests while the background threshold or 85-image trigger still holds. At turn end, an ordinary completed candidate requires the persistence threshold or image pressure. An unfinished candidate is deferred. Waiting is justified by 85 images or usage strictly greater than `W + min(0.25 × W, 50,000)`; explicit manual compaction and overflow recovery also wait.

Pi's automatic threshold cancellation is treated as deferral, so its `session_compact_failed` callback does not accidentally delete reusable work.

## Cross-turn ownership

Turn cleanup parks a candidate rather than cancelling its provider request. Both in-flight and completed candidates can survive into the next turn in the same computer process. A candidate must match the captured message prefix and system prompt. New messages may be appended; changed earlier context invalidates it. Model, reasoning, tool-catalog, and window changes alone do not invalidate the result. The generation request keeps its captured schemas through retries.

An unfinished candidate claimed at the beginning of a turn becomes active work and uses the normal current-pressure gates. A candidate that finished while parked is a stored adoption: current persistence pressure, valid token pressure captured at launch, or current image pressure can justify adoption. Captured early thresholds survive a turn change. This allows a legitimately started completed summary to be adopted even when the next turn's usage is lower. Stored adoption emits `pending_summary_adopted`; merely carrying an unfinished request into another turn does not give it that reason.

The coordinator bounds retained background candidates to 64 contexts and cancels the oldest when capacity is reached. Explicit discard and context deletion still abort outstanding inference. In-flight work is not persisted across computer-process restarts, matching the inspected Grokbot box store's process lifetime.

The durable archive manifest and `compaction.intent.json` serve a different purpose: reconciliation around Pi persistence and archive adoption. Their existing content addressing, monotonic epochs, and restart recovery remain in place. All runtime compaction reads and archive offsets use `SessionManager.buildSessionContext()`. Pi's live agent history can omit retry failures that remain in the saved transcript, so its message positions must not be mixed with persisted positions. At `message_end`, the completed message is appended to the observation explicitly because Pi persists it after the extension hook. This prevents duplicated results or restored failures after overflow and session reopen.

## Retries and failures

Summary generation permits three attempts. Transient errors normally wait two seconds. Input-limit failures reduce the current input immediately; output-limit failures reduce input and append the reference's shorter-output instruction once. Empty output retries immediately without undoing earlier reductions or instructions.

The active generic factory also opts into immediate retries for a missing assistant response; the lower-level retry helper does not enable that option by default. Usage, reasoning counts, and cost reported by completed attempts accumulate even when their text is empty. The response decoder preserves reported usage on a typed missing-assistant error from a completed non-error envelope. Provider-declared errors are rejected before that accounting, matching the generic stream consumer. A thrown failure with no exposed usage cannot contribute invented token counts.

When tool results form at least a quarter of the generation history, reduction drops tool exchanges. Otherwise it keeps a later half, skipping leading tool results. Further retries reduce that already-reduced input. A single string of at least two characters can be halved; structured text parts retain their shape and text. Retry selection follows the reference before Pi serialization. Pi's serializer supplies missing results for unfinished retained calls; capture/adoption tail closure is separate.

Explicit generation rejects fewer than three messages, counting Pi's separately supplied system prompt, before assistant-envelope filtering. Background observations can still decline to start when no partition exists. Three empty completions produce the reference's exhausted-retry error.

Pi resolves some failed streams to assistant-message values. The adapter rejects `error`, `aborted`, and `length` statuses before extracting successful summary text, including when a failed stream contains partial prose. It converts Pi custom messages to their normal model-visible representation and passes tool schemas without executors. Structured transport errors preserve the reference's category precedence; Pi's HTTP statuses and error strings have additional normalization. Resource exhaustion caused by malformed JSON or invalid arguments is terminal. Output containing only thinking tags becomes empty output and uses the empty retry path.

Exhausted input/output-limit failures suppress automatic relaunch at the same or greater pressure for the same model context. A compatible successful adoption clears that suppression. Explicit blocking recovery remains available. The existing five-attempt main-model overflow budget is separate from the three summarizer attempts.

## Deliberate runtime adaptations

- OpenTeam requires trusted user-info metadata; user-authored markup does not become platform context.
- Pi tool calls and results are kept as complete exchanges across capture/adoption boundaries. Retry reduction follows the reference suffix rule and relies on provider serialization for unfinished calls.
- Custom Pi transcript messages are converted using Pi's standard `convertToLlm` function at the summary request boundary.
- After direct projected adoption, raw pre-compaction provider usage is stale. Until a fresh response measures the effective request, pressure uses an estimate including the system prompt, tools, carrier, and retained tail. Images have a separate estimate; encoded file bytes are not counted as text tokens. `tokensAfter` remains an estimate, not a measured compression ratio.
- The generic self-summary path is the target. Grokbot's server temporal harness, external summarizer service, provider-native opaque compaction handlers, and private provider metadata transport are not bundled into OpenTeam.

## Validation

`apps/computer/test/compaction-parity.test.ts` checks partitioning, progressive retries, early thresholds, parked/claimed candidates, prefix rejection, reuse after model/tool changes, image/overage boundaries, suppression, stale usage, and cancellation. `apps/computer/test/runtime/compaction.test.ts` runs actual Pi sessions with offline provider fixtures. It covers nonblocking completion, reopened adoption, overflow followed by a tool loop, refresh notes, and five failed overflow attempts with no sixth request. A provider serialization test covers an unfinished tool call in the summary input and confirms returned tool calls are not executed.

The expanded differential diagnostic is `findings/compaction-investigation-2026-09-12/qa-compare.ts`. It compares selected exact functions, prompt constants, carrier construction, and the stored-adoption threshold predicate from the verified host with current OpenTeam code. Earlier investigation and post-port results remain historical evidence. These checks establish specific behavior, not equal model quality or complete host equivalence. Live summary fidelity and continuation quality remain model-dependent and have not been established by the offline tests.

## Historical investigations

These results describe the versions tested on September 12 and 13, 2026. Test counts and deployment observations are historical. Paths under `findings/` refer to local artifacts excluded from the repository; normal tests use checked-in fixtures.

QA on September 12, 2026: computer type checking and build passed; the computer suite had 251 passes, 12 platform-dependent skips, and zero failures. The focused compaction suite passed 88 tests; the worker archive-projection check passed separately. The expanded reference diagnostic matched 121 of 122 selected cases, with no unexplained mismatches; trusted user-info detection is the recorded adaptation. See `findings/compaction-investigation-2026-09-12/QA.md` and `qa-verification.json` for scope, remaining gaps, logs, and source hashes. These results do not certify all of Grokbot as one-to-one.

The September 13 extension executes the captured generic pipeline, stream consumer, retry loop, and active factory against the real OpenTeam coordinator/adapter. Its 2,048-case fault matrix agrees on all attempt counts, success/failure outcomes, error categories, summaries, replacements, and summary counts. Remaining request-history differences concern Pi tool-exchange closure and single-text-part reduction; remaining usage differences concern metadata exposed only by the injected Grok missing-response envelope. An additional 384-case launch matrix matches completely after correcting the rounded self-summary launch condition.

Six paired experiments on the same live `openai-codex/gpt-5.5` backend produced identical normalized compaction requests. All 22 synthetic facts were recoverable from each of twelve compacted contexts; one answer added a project-name qualifier and failed the strict literal score, which remains recorded separately. This is a bounded shared-model experiment, not native-provider or whole-product equivalence. The current focused suite has 91 passing tests; the full computer suite has 257 passes and 12 skips; worker projection, computer type checking, and build pass. See `findings/compaction-differential-2026-09-13/REPORT.md` for native Grokbot observations, raw evidence, limitations, and reproduction.

The separate native Grokbot stress test completed an archive transition but answered none of the 22 subsequent recall fields. Its archive contained the original ledger among summarized messages; the new summary omitted the fact values apart from the project name. Independent read-only decoding on its computer confirmed the loss of distinctive values. A shared-model follow-up with and without the native no-restatement wording did not reproduce that failure. Model-dependent omission remains a material limit of behavioral cloning. Grokbot archive field 4 is the summary-message blob, and `window_tail` is logging metadata; neither is a list of preserved-tail messages.

A later September 13 recheck inspected Grokbot's computer and captured installed host `886e13a`. The selected generic pipeline definitions, prompts, factory, and box configuration remain byte-identical to `ecc8113`; the orchestrator's changed settled-prefix branch applies to other compaction modes. Against this new source, launch checks still match 384/384, the fault matrix matches 1,776/2,048 across its compared fields, and the original strict shared rig matches 36/44. An expanded strict rig matches 50/92: ten retry/accounting cases differ, and 32 short-history cases expose Grok's pipeline rejection versus OpenTeam's skipped compaction. All 54 successful pairs have equal serialized continuation requests.

Actual SDK fixtures refine the missing-response limitation: Pi can retain usage inside a failed assistant result, which `inferCompaction` rejects without forwarding that usage. A usage-only unfinished stream is not Grok's missing-assistant envelope. The delayed tool-result fixture also violates Pi's ordering requirements; its failures remain recorded, while added valid adjacent and parallel tool histories match retry requests. The new SDK regression passes. Full computer tests passed 265 with 12 skips; the focused compaction suite passed 92. The final type check reports unrelated search/fetch errors. Exact equivalence remains unestablished. See `findings/compaction-recheck-2026-09-13/REPORT.md` for current-source hashes, corrected harness outcomes, logs, and reproduction.

The subsequent parity-fix pass changed retry reduction, explicit short-history rejection, empty-retry errors, and reported missing-assistant usage. Against captured host `886e13a`, the production reducer matches 7,026/7,026 checks, the response-preserving generic pipeline matrix matches 2,048/2,048, and the strict shared rig matches 92/92. Running the saved pre-fix coordinator against that same response-preserving rig matches only 50/92. The legacy adapter that discards missing-response usage still matches 86/92; its failures are preserved. The reported-usage variant exercises the production response decoder with the same receipt exposed to Grok's consumer, and does not reclassify Pi's unfinished SSE streams as successful envelopes.

A repository regression serializes 216 reduced valid/unfinished Pi tool histories and verifies paired requests. Full computer tests pass 270 with 12 skips; computer type checking, build, and worker projection pass. The reference host, private native transport, model-dependent summary quality, and failure telemetry are not certified as a whole by these controlled checks. See `findings/compaction-parity-fixes-2026-09-13/REPORT.md` for the implementation diff, equal-harness control, exact comparison fields, and remaining limits.
