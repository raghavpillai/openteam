# Grok Bot vs OpenBot memory and context parity audit

Date: 2026-08-29  
Scope: installed-source audit, disposable live probes, parity implementation, and validation  
Installed Grok Bot app: 0.29.0  
OpenBot stack: live Compose stack from the current dirty worktree

## Verdict

OpenBot now matches the current source-verified Grok Bot behavior for automatic
compaction, prompt reconstruction, file-backed memory, compaction-epoch memory
freezing, the host-lifetime dreaming experiment, and Bot-visible attachment
materialization. The four concrete differences found in the first pass were
implemented and regression-tested: Grok's five-call overflow budget, normal but
non-executable tool schemas during summary inference, stripping an empty trailing
assistant only from summary input, and host-scoped dreaming defaulting off.

This is observable/file-contract parity, not a claim that the private storage
engines are byte-identical. Grok persists protobuf/SQLite state and uses a cloud
replica; OpenBot retains PostgreSQL and Pi JSONL alongside Grok-compatible files.
No tested prompt, memory, attachment, restart, or continuation behavior differs.

## OBSERVED

### Real OpenBot memory probe

Three disposable OpenBot Bots were created through the public API and removed
after the probe. The shared test fact was explicitly forgotten before removal.

- Bot A wrote one agent/profile fact and one user/profile fact through the real
  `update_state` tool. Both exact fact lines appeared under the expected
  `agents/<id>/memory/profile.md` and `user-memory/by-agent/<id>/profile.md`
  paths.
- Bot A subsequently answered `OWN_YES GLOBAL_YES` without reading files or
  using tools.
- Bot B answered `GLOBAL_YES OWN_LEAK_NO`. This proves the user shard merged
  globally while A's agent memory did not leak into B.
- Bot A's `store.db` KV held `memoryPromptSnapshot` at `compactionEpoch: 0`.
  It contained the first own and global facts, but not the later revived fact.
  This is direct evidence for first-fact-live then epoch-freeze behavior.
- With dreaming enabled for that earlier OpenBot probe, forgetting the exact agent fact
  `OPENBOT_TOMBSTONE_GAMMA_20260829` removed the fact and created empty file
  `memory/.dreaming/tombstones/71388c69c551f7ce.deleted`. The filename is
  `sha1(lower(normalized content))[:16]`.
- Explicitly writing the same fact again removed that tombstone and restored
  the fact line.
- The global user fact was removed before cleanup. All three disposable agent
  directories and the compaction context were removed.

### Real OpenBot compaction probe

The disposable `Parity Compaction 20260829` Bot received 85 real 1x1 PNG image
parts through the public message API: 14 turns with six images and one final
turn with one image.

- Turns 1-14 completed normally with no visible compaction UI.
- The final run began at `2026-08-29T14:38:43.551Z` and completed at
  `14:39:04.209Z`. Background summary generation started at
  `14:38:46.215Z`; end-of-turn adoption waited for it to finish.
- `ContextSession.compactionEpoch` advanced from 0 to 1.
- `ContextCompaction` and the archive manifest agreed on:
  - sequence/epoch 1;
  - reason `approaching_image_limit`;
  - 85 images;
  - 16 user turns including onboarding;
  - 17,191 estimated tokens before and 542 after;
  - one stable compaction id.
- The archive blob contained 33 summarized messages, 84 archived image parts,
  the last real user message with the 85th image, user-info, one durable block,
  no orphan tail, and a substantive 1,146-character continuation summary. It
  was not an acknowledgement-only summary.
- No visible `RunItem` or compaction notice was emitted. The visible transcript
  rows remained available.
- A no-file post-compaction turn replied `CONTINUITY_15`, proving successful
  reconstruction and recall of the last pre-compaction boundary.

### Installed Grok memory/snapshot probe

The existing disposable `Parity Probe v3` Bot was used through the installed
Grok Bot app. Official `update_state` calls wrote two unique facts:

- an own fact under
  `agents/<probe-id>/memory/profile.md`;
- a user/global fact under
  `user-memory/by-agent/<probe-id>/profile.md`.

Both the writer Bot and an already-compacted disposable Bot answered that the
new facts were absent without using tools. This is the expected, source-backed
result: both had already minted a fact-bearing `memoryPromptSnapshot` in their
current summary epoch, so later disk writes were frozen until the next epoch.
The probe therefore distinguishes snapshot behavior from write failure.

Cleanup used official `update_state` forget operations. A final read-only check
from the disposable writer reported `OWN_ABSENT=YES GLOBAL_ABSENT=YES`; no exact
test fact remained. Agent forget with the live dreaming gate produced no
tombstone, consistent with the installed host's effective dreaming-off path.

### Attachment bug found and fixed

The first live OpenBot probe found that uploaded assets were staged under
`<agent-data>/.openbot/assets` while legacy reconciliation deleted
`<agent-data>/.openbot`. A successfully uploaded asset disappeared at the minute
boundary and the next message failed with `404 asset_not_found`.

The fix moves staging to a separate internal asset volume, removes the blanket
legacy deletion, and materializes verified bytes at the Grok-visible path
`agents/<id>/attachments/<sha256><lowercase-extension>` (`.bin` fallback).
Same bytes and extension dedupe to one path; a different extension retains a
distinct path. An active staged asset now survives reconciliation.

### Test results

- Focused compaction/tool-surface/contracts/assets: 83 tests passed,
  279 expectations.
- Four real-PostgreSQL integration files run together: 7 tests passed,
  155 expectations. They cover prompt snapshots, memory lifecycle, attachment
  retention/materialization, malformed state, and file watchers.
- Focused TypeScript validation for computer, messaging, contracts, server, and
  the database dependency completed successfully.
- The repository-wide `bun run check` completed successfully: all 10 typecheck
  tasks, the complete test suite, and all 10 production builds passed.
- The final `openbot-computer` image was rebuilt and inspected directly. Its
  installed Pi runtime contains the maintained five-call overflow guard and
  terminal `summarization-retries` path, does not contain the old one-shot
  guard, and imports `AgentSession` successfully at runtime. This inspection
  caught and fixed a Docker packaging path that had reinstalled the unpatched
  upstream file after the application build.
- Real OpenBot model runs: own/global write, cross-Bot recall/isolation,
  tombstone, revival, 85-image adoption, and post-compaction continuity passed.

### Existing real Grok Bot evidence revalidated

The installed app is still version 0.29.0. The prior disposable installed-Grok
probe in
[`33-grok-context-compaction-live-validation.md`](./33-grok-context-compaction-live-validation.md)
remains the strongest live threshold evidence:

- no archive at 242,334 / 256,000 tokens, 866 tokens below the 95% boundary;
- a small next block caused token collapse to 55,138, archive count 1, one
  summary message, 87 archived message blobs, and a nine-message window tail;
- every old blob and visible message remained;
- all three recall anchors survived;
- the UI showed no notice, progress, inspector, or undo surface.

The fresh memory probe above used only the pre-existing disposable Bot and exact
test facts, then removed those facts. No real Bot profile, routine, skill,
setting, avatar, or unrelated memory was mutated.

## SOURCE-VERIFIED

### Grok automatic compaction contract

Source: installed `/home/box/sand-host/host-main.cjs`, with original paths and
symbols recorded in plan 33 and its evidence report.

- `SelfSummarizer` starts work at
  `min(maxTokens - 10_000, maxTokens * 0.90)` and persists/adopts at
  `min(maxTokens - 5_000, maxTokens * 0.95)`.
- The 1,000-user-turn gate starts `approaching_token_limit` work but does not
  itself persist or block.
- The 85-image boundary uses `approaching_image_limit` and can wait at the
  end boundary if the background result is not ready.
- Provider overflow uses the same summarization pipeline with overflow reason
  precedence.
- `AgentLoop.runWithSummarizationRetry` permits five overflowing model calls for
  one step. Calls one through four compact and retry; the fifth still compacts,
  then throws `StepRetriesExhaustedError("summarization-retries")`. A successful
  rewritten call continues under the separate step budget; a later model step
  receives a fresh five-call allowance.
- `SelfSummarizer.generateSummary` makes three attempts total. Transient retry
  delay is 2,000 ms. Empty output retries immediately with full inputs. There
  is no summarizer-specific timeout.
- Summary inference receives the same model-visible tool schemas and
  descriptions as a normal turn, but `SandSelfSummaryPromptToolExecutor` uses
  its stream-only path and never invokes a tool executor. Tool events are
  discarded.
- Empty trailing assistant envelopes are removed from summary input only. They
  are not deleted from stored history as a prerequisite for compaction.
- Appended suffix content is valid. A changed captured prefix or system
  snapshot invalidates/restarts the pending result.
- The reconstructed model prefix is current user-info, the last real user,
  numbered summary carrier, and a complete appended suffix/tool exchange.
- Earlier summaries can be summarized semantically, but archive objects do not
  recursively embed prior archive objects.
- `ConversationStateHandler.pushSummaryArchive` advances
  `summaryArchives.length` only after a successful persist.
- Visible transcript and content-addressed blobs are retained; old content is
  excluded from the reconstructed model prompt rather than deleted.
- There is no Grok Bot Compact/new-session/working-set-meter control on desktop
  or mobile. The IDE's `/summarize` command is a different product surface.
- Group, A2A, routine, bootstrap, and subagent-completion wakes use the member
  Bot's home model context. Room history remains a separate visible transcript.

### Grok memory contract

Source symbols and original paths:

- `FileMemoryStore`, `UserMemoryStore`, `ProjectMemoryStore`, `MemoryService` in
  `src/host/extensions/memory/memory-service.ts`;
- `runTurnMemory` in
  `packages/grok-bot-harness/src/runner/turn-memory.ts`;
- `MemorySynthesisService` in
  `src/host/extensions/memory/memory-synthesis-service.ts`;
- `resolveFrozenMemoryPrompt` in the Grok harness memory assembly;
- `agentProfilePromptSnapshot` and `memoryPromptSnapshot` in agent DB KV.

The file and merge behavior is:

- recognized facts are exact single lines matching
  `^-\s+\((YYYY-MM-DD)\)\s+(.+?)\s*$`;
- content collapses whitespace, trims, and clamps to 500 characters;
- id is `sha1(lower(normalized content))[:16]`;
- `[note] ` and `[episode] ` remain in content and control importance/tier;
- invalid and multiline content is ignored but left on disk;
- user and project memory use per-writer shards; same-id merge picks the newest
  UTC date and keeps the lexicographically earlier writer on a same-day tie;
- prompt order is user, project, own; instructional precedence is the reverse;
- empty memory does not freeze. The first fact-bearing turn reads live and
  mints the epoch snapshot. Later changes wait for compaction unless an official
  forget invalidates snapshots;
- agent-only explicit forget creates an empty tombstone only when dreaming is
  enabled. Explicit rewrite revives. User/project shards have no dreaming or
  cross-writer tombstones;
- dreaming evidence is RAM-only in the shipped bundle: at most 12 entries per
  agent and 64 agents. `.dreaming/evidence/*.json` is reader/deleter recovery
  code with no matching shipped writer;
- dreaming uses synthesize + verify, up to three schema attempts under a
  90-second total deadline, and a 24-hour temporal review marker;
- dreaming off performs extraction and emits one `[episode]` narrative after
  six memorable turns; dreaming on replaces that path and clears pending
  episode state.
- dreaming is selected by the host experiment `sand_memory_dreaming`, whose
  registry default is false. The first resolved value is pinned for the host
  lifetime. It is not a Bot setting and is absent from `settings.json` and the
  `update_state` schema.

### OpenBot implementation mapping

- `apps/computer/src/grok-compaction.ts`:
  `GrokCompactionCoordinator`, `GrokCompactionArchiveStore`, threshold helpers,
  retry classifier, prefix validation, archive format, byte guard.
- `apps/computer/src/runtime.ts`: Pi `context`, `message_start`,
  `session_before_compact`, `session_compact`, and failure hooks; isolated
  summary inference with normal non-executable tool schemas; staged-intent
  recovery.
- `patches/@earendil-works%2Fpi-coding-agent@0.84.3.patch`: maintained
  dependency patch implementing Grok's five-call overflow budget and terminal
  fifth compaction.
- `packages/messaging/src/memory-files.ts`: exact parser, normalization, ids,
  origin/tombstone state, evidence spool reader, synthesis fingerprint/apply.
- `packages/messaging/src/agent-data.ts`: writer shards, prompt rendering and
  freeze, extraction/episode path, host-pinned dreaming gate, RAM dreaming
  queue, synthesize/verify, and SHA-addressed attachment materialization.
- `apps/worker/src/worker.ts`: home-context routing and post-turn memory capture.

The exercised behavior of these components agrees with the Grok contract above.

## INFERRED

- The new OpenBot live timing is consistent with Grok's two-stage behavior:
  summary generation is nonblocking while the model works, but the persist
  boundary delays turn completion if the result is still pending.
- The forum statement that Grok always sends the full transcript is true before
  the first automatic compaction but false afterward. After adoption, old
  messages remain stored/visible but are excluded from the reconstructed prompt.
- Creating a new Bot is required only as a workaround for an explicit fresh
  session/manual prune. It is not required for automatic near-limit compaction.

## UNKNOWN / NOT LIVE-FORCED IN THIS PASS

- A fresh OpenBot 90% token-boundary run was not forced; it would require a very
  large paid context. Deterministic tests cover start, nonblocking behavior,
  prefix invalidation, suffix retention, and between-step adoption. The real
  Grok 256k run covers the actual token threshold.
- A live 1,000-turn gate and real provider overflow were not forced.
- The raw Statsig assignment returned for this installed Grok host was not
  exposed. The disposable behavior observed the dreaming-off branch, while the
  source default is false and the resolved value is host-lifetime-pinned.
- Same-day two-writer conflict, 64-agent evidence eviction, and a crash during
  synthesis were source-verified but not forced against the live Grok service.
- The fresh 85-image OpenBot archive was not restarted before cleanup. An older
  disposable OpenBot archive already passed computer-service restart and
  continued on the same Pi JSONL/context.

## Exactness boundary

Grok persists protobuf `ConversationSummaryArchive` state in its SQLite/blob
system. OpenBot uses Pi JSONL plus content-addressed JSON manifests and a
PostgreSQL projection. Observable continuation and file behavior match; private
serialization bytes and Cursor's cloud object backend do not.

## Planning cleanup

The completed v0, Pi migration, filesystem-runtime, and compaction plans were
removed on 2026-09-01 after their shipped behavior was verified. Current
authority is `apps/computer/src/grok-compaction.ts`,
`apps/computer/src/grok-agent-store.ts`, `packages/messaging/src/agent-data.ts`,
their tests, and `plans/30-canonical-context-handoff.md`.

`plans/32-agent-data-filesystem-parity.md` remains because external-event
delivery and source-incomplete routine safety policy still have open gates; its
historical sketches do not override current code.

## Forum claim check

References:

- [post 5: local working-set prototype](https://forum.cursor.com/t/grok-bot-prune-compact-an-agent-s-context-without-creating-a-new-bot/168333/5)
- [post 9: iPhone/manual-compaction complaint](https://forum.cursor.com/t/grok-bot-prune-compact-an-agent-s-context-without-creating-a-new-bot/168333/9)
- [staff explanation in the same thread](https://forum.cursor.com/t/grok-bot-prune-compact-an-agent-s-context-without-creating-a-new-bot/168333/7)

- Post 5 describes the author's local prototype, not shipped Grok behavior.
  Its manual Compact, New session, archive tab, and working-set meter are
  rejected as descriptions of Grok Bot.
- Durable identity living separately from chat is confirmed.
- Near-limit automatic summarization is confirmed.
- No explicit Grok Bot Compact/New session/working-set meter on desktop or
  mobile is confirmed.
- Post 9's claim that a new Bot is the only available explicit-reset workaround
  is substantially confirmed. It is not required for automatic compaction.
- The broad claim that the full transcript is always resent is rejected after
  a summary archive exists. Storage/visibility retention is not prompt inclusion.

## Remaining safe probes

1. If spend is acceptable, force a real provider overflow and verify the live
   five-call ceiling. The exact loop is already source-verified and covered by
   a deterministic dependency-level test.
2. Force a fresh paid OpenBot 90/95% token crossing. The real 85-image OpenBot
   adoption and installed-Grok 256k crossing already exercise the same
   persistence and reconstruction path.
3. Restart a disposable OpenBot immediately between summary generation and
   adoption to stress the narrow staged-intent recovery window.

The older plan discrepancies listed above are documentation debt, not known
runtime parity defects.
