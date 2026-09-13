# Grok Bot memory compatibility

OpenTeam implements the verified file-based Grok Bot memory lifecycle from host `ecc8113`, inspected September 12, 2026. This is a behavior port into OpenTeam's worker, database, and filesystem architecture. It is not a copy of Grok's inaccessible Temporal backend, and it does not establish identical learning quality across models.

The follow-up audit found additional gaps that the initial tests missed and fixed them. The final scoped verification passed **110 tests**, **267 direct reference comparisons**, and **17 real-model checks**. These establish the tested behaviors, not complete product parity or a guarantee for every model response. See [the audit report](../output/research/grokbot-memory-2026-09-12/parity-audit/report.md) for evidence and remaining gaps. The deployed worker was inspected and still contains the older extraction implementation.

The source bundle used for the investigation has SHA-256 `56b7bf316d5c84daab56bb91196186256c7aa0170bc261e079e4a0e194a656c2`. The local investigation, source manifests, and original executable probes are in `output/research/grokbot-memory-2026-09-12/`. The checked-in reference fixture records this fingerprint and contains outputs independently generated from that runtime, so normal tests do not require the research bundle.

## Implemented behavior

| Mechanism | Behavior |
| --- | --- |
| Turn eligibility | Hidden/empty turns are excluded; the legacy learner uses the reference short-chatter vocabulary, punctuation normalization, 40-character threshold, and question-mark exception. |
| Extraction context | Up to 100 current profile facts and 30 recent log facts, plus up to ten relevant archived facts. The 500-record archive lists profiles first, then logs, each by recency. Recent log selection uses the existing 30-day importance rank. |
| Extraction protocol | The reference `profile:`, `log:`, `note:`, `remove:`, and `NONE` output protocol, case/whitespace deduplication, line markers, and 500-character normalization. Notes persist as `[note]` log entries. |
| Corrections | Remove only text included in the supplied existing-memory context, then add replacements. Apply under the bot-file mutation lock and reconcile the database index. Unrelated facts and Markdown survive. |
| Episodes | Every six eligible turns by default; configurable interval. Pass full pending exchanges with absolute dates to the reference journal-summary prompt. Persist a dated `[episode]` log entry and clear pending turns even when summary generation fails or returns `NONE`. |
| Dreaming | An optional replacement for legacy extraction and episodes, still default-off. Existing 15-second debounce, hourly sweep, 24-hour review interval, and bounded queues are retained. |
| Synthesis and verification | The reference prompts and request shapes; strict JSON, at most 64 changes, supplied evidence citations, protected explicit entries, and conservative clock-only updates. Empty proposals skip verification. |
| Retry lifecycle | Up to three attempts covering proposal and verification together, including verifier rejection. Each attempt gets a fresh 90-second deadline; backoff starts at two seconds. Shutdown cancels pending inference/retry work. |
| Evidence bounds | Preserve the first and last 4,000 characters, plus the 24-character omission marker, when a side exceeds 8,000 characters. |
| Explicit protection | Read current origin metadata at synthesis commit, even when an explicit re-save left the Markdown fingerprint unchanged. This closes the reproduced update/removal race. |
| Synthesis commit | Capture facts and fingerprint from the same file contents; use global ordering across files; select the reference occurrence of duplicate facts; preserve proposal order; stage edits and replace each touched file once. |
| Evidence spool | Parse before bounding Unicode/JSON-escaped text. Return all spooled evidence to the scheduler, which selects the newest 12 after merging RAM and disk and cleans every consumed ID. Older overflow files are not replayed later. |
| Cancellation | Propagate worker cancellation through the HTTP request to the computer's provider completion. Caller cancellation and inference deadlines abort the underlying completion. |
| Recall and prompts | Existing lexical recall, profile/history separation, user/project writer shards, importance ranking, frozen prompt sections, delivery acknowledgements, and compaction refresh remain in use. A correction is reflected in the next memory replacement note without rewriting the frozen prefix. |

`memory-prompts.ts` uses the four inspected inference prompts with only the assistant name changed from Grok Bot to OpenTeam. Tests compare their hashes against independently generated reference hashes.

For line-protocol compatibility, untagged extractor text is accepted as a log fact, as in the reference implementation. `NONE` is the no-op response; the old `{"facts": [...]}` extraction and `{"narrative": ...}` episode formats are no longer used. Custom inference adapters and test doubles must use the current protocols.

## Configuration

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `OPENTEAM_MEMORY_DREAMING` | `false` | Select synthesis instead of per-turn extraction and episodes. |
| `OPENTEAM_MEMORY_EPISODE_INTERVAL` | `6` | Eligible turns per episode. `SAND_MEMORY_EPISODE_INTERVAL` is accepted when the OpenTeam variable is absent. |
| `OPENTEAM_MEMORY_MODEL` | Empty | Optional `provider/model` for memory inference. A bare model ID uses the configured provider. |
| `OPENTEAM_MEMORY_REASONING` | Main setting, or `off` with a memory-model override | Independent memory reasoning level. |

Development and release Compose pass these settings to the worker. The inspected Grok host's synthesis factory selected `gemini-2.5-flash`; `OPENTEAM_MEMORY_MODEL=google/gemini-2.5-flash` selects that model through a connected Google provider. The default continues using the user's configured inference provider/model so existing installations do not silently require a new provider connection. This is an explicit adaptation, not an assertion of identical model defaults.

The existing storage is read in place; no memory migration or live feature-gate change is required. Worker restart loads code/configuration changes. No deployed worker was restarted by this implementation task.

## Boundaries of the port

- Grok's newer server-backed memory implementation was not available. Its complete storage transactions, model selection, extraction pipeline, and retention policies cannot be copied or certified from the inspected host.
- Conversation-local memory, same-audience sibling sharing, and team-wide visibility were described by newer contracts. OpenTeam still uses its existing agent/user/project scopes; this change does not invent server authorization semantics.
- OpenTeam retains its PostgreSQL index and advisory locks, existing prompt renderer and file watcher, and stricter validation of invalid Markdown calendar dates. This is not byte-for-byte filesystem/parser/prompt-renderer equivalence. The internal `synthesized` origin is mapped to the reference `synthesis` label for inference.
- Synthesis evidence capture remains a bounded in-memory queue with support for reading existing spool files. A crash-durable capture writer was not established in the reference and was not added here.
- Recall is lexical. Exact-text tombstones and deduplication do not imply semantic conflict resolution or forgetting all paraphrases. LLM outputs remain probabilistic even with matching prompts.

## Verification

`memory-reference.json` contains 51 cases generated from the installed source: turn eligibility, extraction parsing, episode intervals, and filesystem-backed selection including large archives and importance ties. Four additional prompt hashes guard prompt parity.

Focused tests also exercise actual temporary-file correction, note persistence, unknown-removal rejection, duplicate suppression, metadata-only protection races, strict synthesis validation, verifier retries, inference deadlines, and cancellation. Database integration tests cover correction through `recordTurnMemory`, reconciled recall after reopening the store, pending episode evidence, prompt replacement notes until delivery acknowledgement, compaction refresh, and an explicit re-save during real synthesis orchestration.

Additional reference fixtures and recovery tests cover duplicate occurrence selection, mixed update/create ordering, cross-file date ties, spool overflow, Unicode and escaped evidence, retrying stale snapshots, evidence arriving during inference, exhausted retries, and stopping during verification. An actual HTTP-disconnect test verifies provider cancellation. Run package test groups in separate processes, as the workspace's package scripts do; the combined cross-package audit invocation reported all assertions passing but retained a process handle after completion.

Run the focused unit tests with explicit relative paths so Bun does not also discover archived source copies under `output/`:

```sh
bun test ./packages/messaging/test/memory-learning.test.ts ./packages/messaging/test/memory-synthesis.test.ts ./apps/worker/test/memory-inference.test.ts
```

Run `memory-parity.integration.test.ts`, `agent-data.integration.test.ts`, and `context-prompt-snapshot.integration.test.ts` with `OPENTEAM_TEST_DATABASE_URL` pointing to a disposable database initialized with the current schema. The new integration tests explicitly skip when that variable is absent. Model responses in these tests are controlled fixtures; these tests verify persistence and orchestration, not live model extraction accuracy.
