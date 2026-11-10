# Signal marketplace validation

Validation takes place in `codex/signal-plugin-validation`, isolated from the dirty main checkout and based on local `8be3b9df`. Evidence is ignored under `output/signal-validation/`; account keys, temporary QR codes and collected live messages are never packaged.

## Verified so far — 2026-11-10

- The original connector passed 84 tests, including seven checks against the real unlinked JVM runtime on macOS ARM64. Independent reviews found and verified fixes for failed identity initialization, interrupted attachment reads, reconnect retries, subprocess trees, response truncation, and optional setup fields.
- Marketplace conversion adds generic managed native dependencies, private persistent account directories, phone approval tools, desktop/mobile QR presentation, cancellation, reconnect and removal. The initial independent infrastructure tests exposed additional defects; the revised implementation passes 178 checks across four files (557 assertions).
- Runtime tests cover pinned size and SHA-256, redirects, archive traversal/PAX metadata, symlinks and hardlinks, extraction limits, cache/library tampering, executable permissions, shared downloads, cancellation, unsupported platforms and strict manifest types.
- Host lifecycle tests exercise pending authorization, concurrent connects, stale completion/cancellation, code expiry, recovery after restart, finish failures, hidden-tool discovery/invocation, offline removal, deletion barriers, account isolation and cancellation during package preparation. These use synthetic peers and an in-memory DB adapter; they are not authenticated Signal coverage.
- A real isolated PostgreSQL database, actual synthetic MCP children, and desktop browser validation passed after the host changes. Final results are recorded below.
- A Linux ARM64 smoke test used the production OpenTeam computer image with Bun 1.4.2. It downloaded the exact manifest-pinned signal-cli/JRE/JNI archives, verified and extracted them, launched 0.14.10, checked unlinked state, obtained a real provisioning URI, cancelled pending approval and restarted cleanly. No linked account was copied into the Linux environment.
- The managed runtime installer also completed on macOS ARM64. The local collector resumed with the resulting managed paths.
- Marketplace registry generation, source provenance, icon checks, package exports and TypeScript checks are part of the final validation. See raw logs rather than treating intermediate totals as the final suite result.

## Final focused results

| Check | Result |
| --- | --- |
| Signal connector, including seven real unlinked-runtime tests | 100 passed; 282 assertions |
| Real phone message reception and synchronized edit through packaged MCP | Passed; message ID and original timestamp preserved |
| Managed runtime/manifest and generic account/link unit regressions | 178 passed; 557 assertions |
| Real PostgreSQL + actual synthetic MCP lifecycle | 8 passed; 98 assertions |
| Native Linux x64 transport/service/store/durability/process-tree tests | 63 passed; 139 assertions |
| Native Linux x64 managed runtime and MCP lifecycle smoke | Passed twice; real provisioning and cancellation passed |
| SDK, plugin package, client and MCP manager regression group | 119 passed |
| Host setup, restart/concurrency and released-update regressions | 12 passed |
| Desktop state merging plus manifest checks | 71 passed (overlaps the manifest group) |
| Server, computer, desktop and standalone connector TypeScript | Passed |
| SDK browser bundle, computer bundle and server bundle | Passed |
| iOS simulator target build | BUILD SUCCEEDED |
| Marketplace ZIP | Built, imported and verified, including binary icon |

Counts overlap between groups and must not be added into a unique-test total. The final independent runtime review reran 188 scoped checks with no findings, including seven additional synthetic removal probes. Its predecessor’s parent-symlink deletion finding is covered by a repository regression. The final lifecycle review independently confirmed the 178 infrastructure and eight real-database checks with no remaining findings in its scoped review.

The real desktop browser flow used the registry package, server routes, PostgreSQL, the computer MCP manager and pinned runtime: install → QR → cancel → stopped process → reconnect → fresh QR. It exposed exactly five public messaging tools and no lifecycle tools. A second run temporarily moved the already-linked private test account into the host-owned account directory, reached Connected, read only tagged test records, inspected an existing send ID without sending again, disconnected and reconnected. The private account was restored after the test. Browser page errors: zero.

The broader server plugin suite also contains older failures in assertions about per-bot plugin isolation and inline skill instructions. A comparison against copied source from base commit `8be3b9df`, using the same installed library versions, reproduced the same 14 management/catalog failures. They were not changed as part of this feature. Logs: `base-commit-comparison.txt` and `current-only-comparison.txt`. This is not a claim that the entire repository test suite is green.

## Authenticated coverage

The user approved a linked-device QR on their phone. The linked runtime starts and subscribes successfully. Labeled Note to Self sends succeeded, and repeating the same request ID returned the saved outcome without sending again. These tests did not send to another person or group.

An own send does not necessarily echo to the same linked device. A temporary implementation synthesized outgoing index entries from contact expiration settings; it was removed because those settings are not authoritative message envelopes. Only provider receive/sync envelopes enter the message index. The persistent send ledger stores fingerprints and outcomes without outgoing bodies.

The phone sent the requested tagged Note to Self message, which the collector received and stored. The packaged MCP connector then returned that message through `list_messages`. An edit made on the phone synchronized correctly: the message ID and original timestamp stayed unchanged, the body updated, and the result reported `edited: true`. The linked collector was also restarted as the packaged MCP entry point between these checks, preserving the collected message. Sanitized evidence is in ignored `private/live-phone-evidence.json`.

The live phone Delete for Everyone check failed twice: both the edited test and a fresh unedited Note to Self test remained in the index. A temporary receive-stream probe observed the fresh original as `syncMessage.sentMessage`, then an empty `syncMessage: {}` after the phone deletion, without a sent message or deletion target. The probe forwarded frames unchanged and recorded only structural keys and timestamps, never raw frames or message bodies. Pinned upstream `JsonSyncMessage` / `MessageEnvelope.Sync` also expose no delete-for-me payload. This establishes an upstream event-information gap for this live path; it does not establish that all direct/group deletion paths fail. The connector cannot identify the deleted message safely from that empty event. This remains an unresolved release blocker; synthetic deletion tests do not supersede this result. Real incoming attachment retrieval, disappearing-message behavior, phone revocation/relinking, rate limits and authenticated network recovery also remain unvalidated.

A real directory lookup exposed a contact listing larger than the host response limit. Contacts and groups now use stable-ID sorting and bounded pages (`offset`, `limit`, `nextOffset`), with optional recipient/group filters for targeted lookups. No directory snapshots are persisted. New regressions reconstruct all 240 synthetic contacts and 80 groups through the host result-bounding path, preserve escaped Unicode fields, reject invalid parameters, and check targeted account-scoped lookups. The real linked account’s collected chat labels were then resolved successfully through the packaged MCP tools. Chat names and unrelated message contents are not included in this report.

## Platform limits

Linux ARM64, native Linux x64, and macOS ARM64 have real-runtime evidence. Windows and macOS x64 are not declared targets.

The native x64 run used a Linux x86_64 machine and `oven/bun:1.4.2-slim` at digest `sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61`, matching the computer Dockerfile’s pinned runtime base. It downloaded and verified the Linux x64 CLI/JRE/JNI pins, checked two real MCP lifecycles with five public tools, obtained and cancelled a real provisioning code, and passed 63 bundled transport/service/store/durability/process-tree tests. The test container had a read-only root, one CPU and a 1.5 GB memory cap. Only connector code and synthetic fixtures were transferred; no linked account keys or user messages went to the remote machine. Logs: `native-linux-x64-exec-smoke.txt` and `native-linux-x64-unit.txt`.

Earlier ARM-emulated x64 attempts were inconclusive. The first native sandbox attempt also failed because its temporary filesystem was mounted `noexec`; allowing native-library mappings in the test temporary filesystem resolved that harness failure. Runtime caches must permit execution, and Java’s temporary directory must permit its native library loading. The production computer’s normal filesystem configuration supports this.

An older preinstalled macOS native signal-cli 0.14.5 crashed during shutdown. The pinned JVM 0.14.10 runtime avoided that failure. An intentionally daemonized descendant outside the connector's owned process group is outside its cleanup contract; the upstream launcher uses `exec` for Java.

## Known product boundaries

There is no old-message backfill, native inbox trigger, Signal draft-review workflow, attachment upload or binary streaming. Oversized results return an intact MCP error at 75,000 encoded characters. Unknown send outcomes never trigger automatic resend.

The index excludes ephemeral content but signal-cli has independent downloaded files and protocol storage. Logical deletion does not erase SQLite free pages, WAL or external backups. Account removal deletes the entire private directory only after stopping account use, and reports failure if deletion cannot be confirmed. Remote linked-device revocation may still require the phone. Shared verified runtimes remain cached.

## History import scope

Signal’s official apps support an encrypted phone-to-linked-device history transfer: https://signal.org/blog/a-synchronized-start-for-linked-devices/. This integration uses the pinned signal-cli JSON-RPC receive interface and does not implement that history import. The maintainer also documents signal-cli’s lack of stored history/Android backup restore in https://github.com/AsamK/signal-cli/issues/1747. This is a limitation of the current integration and upstream interface, not a general prohibition on Signal history transfer.

## Integration with current main — 2026-11-10

Merged `origin/main` at `d560b8df` into this isolated branch and resolved nine text conflicts. Main's shared server/worker namespace builder now filters manifest-declared and metadata-only host tools; its current schema repair, diagnostics, UI loading component, client endpoints and SDK exports are preserved.

Independent review found two adjacent account cleanup defects. Configuration saves now compare the runtime generation atomically, preserving another service's pending-removal gate. Package updates reject retirement of persistent connectors/storage, and revalidate locked account generations and removal gates before changing manifests or credentials. Four additional PostgreSQL regressions exercise stale saves, both storage-retirement variants, and removal during update. A fifth confirms that compatible updates preserve private state and subsequent account removal still deletes it. New links also use the device name **OpenTeam Signal**.

Post-integration results:

| Check | Result |
| --- | --- |
| Signal connector including seven real macOS ARM64 runtime checks | 100 passed; 283 assertions |
| All server plugin suites with isolated PostgreSQL | 155 passed; 3 optional provider tests skipped; 0 failed; 2,043 assertions |
| Focused PostgreSQL lifecycle tests, including five new regressions | 13 passed; 122 assertions; pre-existing rows unchanged and fixtures cleaned |
| Runtime/manifest/link/state unit regressions | 178 passed; 557 assertions |
| SDK/package/client/MCP regressions | 130 passed; 1,883 assertions |
| Shared namespaces and connector suite | 96 passed; 7 real-runtime checks skipped in that invocation; real checks passed separately above |
| Independent scoped integration review before the two fixes | 53 passed; 356 assertions; two findings fixed with real-database regressions |
| SDK, contracts, client, server, worker, computer and desktop TypeScript | Passed after regenerating the local Prisma client |
| Standalone Signal TypeScript | Passed |
| SDK browser, server, worker and computer bundles | Passed |
| Signal ZIP round-trip | Passed |

Groups overlap and are not a unique-test total. The old-base management/catalog failures described earlier did not recur in the complete post-main server-plugin run. No claim is made about unrelated whole-repository suites or about untested live scenarios. Live phone deletion remains a release blocker despite the passing automated tests.
