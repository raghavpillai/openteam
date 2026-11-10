# Signal marketplace validation

Validated on 2026-11-10 in the isolated `codex/signal-plugin-validation` worktree. The branch includes `origin/main` at `d560b8df`. Private account state, QR codes, test messages and evidence remain ignored under `output/signal-validation/private/` and are never packaged.

## Current results

| Check | Result |
| --- | --- |
| Complete Signal connector suite, including real macOS ARM64 runtime, packaged MCP and Java protobuf checks | 124 passed; 401 assertions before the final view-once regression |
| Combined CI entry point: connector, runtime assets, manifest, host linking and account state | 308 passed; 1 provisioning test deliberately filtered; 976 assertions |
| Complete server plugin suite with isolated PostgreSQL | 164 passed; 3 optional provider tests skipped; 2,080 assertions |
| PostgreSQL lifecycle suite with actual synthetic MCP children, including pending-QR regeneration | 15 passed; 134 assertions |
| Independent final recovery review | 64 passed; 290 assertions; no remaining finding |
| Final view-once Java/storage regression group | 38 passed; 1 packaged-runtime check skipped in that invocation; 131 assertions |
| SDK, contracts, client, server, worker, computer, desktop and standalone Signal TypeScript | Passed; desktop rerun after QR regeneration UI change |
| SDK browser, server, worker and computer bundles | Passed |
| Marketplace ZIP round-trip | Passed, including binary icon and compatibility JAR/source |

Counts overlap and must not be summed. The final iOS attempt compiled `PluginConnectionActions.swift`, but the full build is blocked by main's unrelated `HomeView.swift:976` use of `GeometryProxy.reservedRegions`, an iOS 27.1 API absent from the installed Xcode 26.6 SDK. An earlier pre-main simulator build passed; the current full iOS target is not claimed to pass.

## Authenticated phone checks

All sends were restricted to Note to Self; no external recipients were messaged. These checks used the exported, materialized plugin through its actual MCP tools and the managed runtime.

| Scenario | Evidence |
| --- | --- |
| Incoming phone text and synchronized edit | Passed; original message ID/timestamp preserved |
| Outgoing self-send and retry identity | Passed; completed request IDs do not send twice |
| Contacts/groups and collected chat labels | Passed; bounded stable-ID pages avoid host truncation |
| Phone Delete for Everyone | Initially failed upstream; passed with the compatibility patch, removing the MCP result and leaving a null-body, empty-attachment tombstone |
| Real incoming attachment retrieval | Passed; 152 bytes matched SHA-256 `5862a2af7b93cc995919317e35724dc18e78871dbf12aaa98aa3f951d5a98ac3` |
| 30-second disappearing message | Passed; event carried expiry 30 and no content/attachment references were exposed by the index |
| Authenticated network interruption and recovery | Passed in the same MCP/controller process after Java-only network blocking; no new phone approval was needed. Queued delivery during the outage was not established |
| Phone linked-device revocation | Passed; connector reported unlinked |
| Fresh relink | Passed; packaged connector subsequently reported linked with runtime 0.14.10 and patch 0.14.10-ot.1 |
| View-once phone photo | Inconclusive. User confirmed the placeholder, but the scoped event probe did not establish its flag/timestamp. An ordinary image metadata row is insufficient to identify it. The user declined an additional phone retest |

View-once exclusion has real protobuf-to-JSON and durable-store replay tests, but live view-once privacy is not declared verified. The test photo was never opened and its bytes were never read.

## Runtime and compatibility patch

Managed downloads are pinned by byte size and SHA-256. Linux x64, Linux ARM64 and macOS ARM64 have real unlinked-runtime evidence, including provisioning/cancellation; Windows and macOS x64 are not declared targets. Native Linux x64 tests used the production computer's pinned Bun image. No linked account state or messages were copied to Linux machines.

The bundled GPL compatibility overlay `0.14.10-ot.1` preserves authenticated DeleteForMe sync metadata that upstream's high-level model discards. It is a small classpath overlay over the pinned, otherwise unchanged signal-cli 0.14.10 distribution. Corresponding source and license ship beside and inside the JAR. Builds were byte-identical on all three declared platforms: SHA-256 `aa12eb434e487298e2207d5e4b74fde878dd6c44c32fcc72a974d600c191238e`. CI rebuilds the JAR and tests real protobuf → authenticated content → manager → JSON and exported MCP execution. It avoids provider provisioning on every PR.

Independent probes covered 24 chained-edit orders, 480 deletion/replay permutations, wrong-version/missing-class rejection and timezone-independent builds. Attachment reads recheck authorization after outstanding reads; remote/sync deletion and attachment-only removal prevent returning stale bytes.

## Recovery and setup

Recovery tests cover manager loss while the RPC dispatcher survives, startup offline with an existing durable identity, bounded process-tree cleanup, repeated launch/bind/subscribe failures, failed QR preparation and replacement-identity rejection. Sends with uncertain outcomes never automatically retry.

Host linking tests cover concurrent connects, cancellation, expired/stale completion, configuration/removal generation fences, stopped-runtime behavior and persistent recovery polling. Desktop and iOS show QR setup with an explicit **Get new code** action. Regeneration uses the existing restart barrier: stop the previous process/waiter, advance its generation and create a fresh session. Expired QR images are hidden. PostgreSQL plus actual synthetic subprocesses verify regeneration before the old approval expires.

Managed runtime tests cover archive traversal, symlinks/hardlinks, extraction limits, redirects, executable permissions, cache tampering, download deduplication/cancellation and unsupported platforms. Host-only lifecycle tools remain excluded from bot discovery and invocation.

## Product boundaries

This integration collects messages from connection onward. Signal's official apps support [encrypted linked-device history transfer](https://signal.org/blog/a-synchronized-start-for-linked-devices/), but the pinned signal-cli interface does not implement that import; see [the maintainer's history explanation](https://github.com/AsamK/signal-cli/issues/1747). There is no native inbox trigger, draft-review workflow, attachment upload or binary streaming. Oversized results return an intact MCP error at 75,000 encoded characters.

The index excludes flagged ephemeral content; signal-cli separately maintains protocol state and downloaded files. Logical deletion does not erase SQLite free pages, WAL or backups. Account removal deletes its private directory only after stopping account use and reports deletion failures; verified shared runtimes stay cached. Intentionally daemonized descendants outside the owned process group are outside the process cleanup contract; upstream's launcher uses `exec` for Java.

Live rate limiting, external-recipient/group messaging and cross-device identity changes remain unvalidated. Synthetic tests do not establish those outcomes. No claim is made about unrelated whole-repository suites or 100% coverage.
