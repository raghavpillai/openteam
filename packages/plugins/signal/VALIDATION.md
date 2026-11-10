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
| Signal connector, including seven real unlinked-runtime tests | 84 passed; 204 assertions |
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

Phone-to-plugin reception of the requested tagged message, real incoming attachment retrieval, edits, deletion, disappearing-message behavior, phone revocation, rate limits and authenticated network recovery still require live validation. Synthetic tests do not establish these properties end to end.

## Platform limits

Linux ARM64, native Linux x64, and macOS ARM64 have real-runtime evidence. Windows and macOS x64 are not declared targets.

The native x64 run used a Linux x86_64 machine and `oven/bun:1.4.2-slim` at digest `sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61`, matching the computer Dockerfile’s pinned runtime base. It downloaded and verified the Linux x64 CLI/JRE/JNI pins, checked two real MCP lifecycles with five public tools, obtained and cancelled a real provisioning code, and passed 63 bundled transport/service/store/durability/process-tree tests. The test container had a read-only root, one CPU and a 1.5 GB memory cap. Only connector code and synthetic fixtures were transferred; no linked account keys or user messages went to the remote machine. Logs: `native-linux-x64-exec-smoke.txt` and `native-linux-x64-unit.txt`.

Earlier ARM-emulated x64 attempts were inconclusive. The first native sandbox attempt also failed because its temporary filesystem was mounted `noexec`; allowing native-library mappings in the test temporary filesystem resolved that harness failure. Runtime caches must permit execution, and Java’s temporary directory must permit its native library loading. The production computer’s normal filesystem configuration supports this.

An older preinstalled macOS native signal-cli 0.14.5 crashed during shutdown. The pinned JVM 0.14.10 runtime avoided that failure. An intentionally daemonized descendant outside the connector's owned process group is outside its cleanup contract; the upstream launcher uses `exec` for Java.

## Known product boundaries

There is no old-message backfill, native inbox trigger, Signal draft-review workflow, attachment upload or binary streaming. Oversized results return an intact MCP error at 75,000 encoded characters. Unknown send outcomes never trigger automatic resend.

The index excludes ephemeral content but signal-cli has independent downloaded files and protocol storage. Logical deletion does not erase SQLite free pages, WAL or external backups. Account removal deletes the entire private directory only after stopping account use, and reports failure if deletion cannot be confirmed. Remote linked-device revocation may still require the phone. Shared verified runtimes remain cached.
