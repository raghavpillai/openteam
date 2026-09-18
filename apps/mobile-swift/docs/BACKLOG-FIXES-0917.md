# Swift backlog fixes — September 17, 2026

This follow-up covers the delivery, plugins, approvals, conversation and computer items requested after the migration audit. Historical failure captures remain available. It does not certify the entire app or physical-device behavior.

## Changes

| Area | Result |
| --- | --- |
| Left-edge navigation | Retains the native interactive back transition and protected leading edge from build 22. Applies the same ownership inside nested thread pages; interior swipes still reply and holds still open message actions. |
| Delivery (QA-07/17) | A missing conversation fails only its own queued send. Other conversations continue sending. Queued messages display staged/uploaded file names and sizes. Settings exposes Retry, confirmed Discard and recovery into another existing draft without automatically sending or overwriting its text/files. Recovery rejects a combined draft above six attachments. |
| Plugin access (QA-09/10/20) | Uses the server maximum of 60 with pagination, search cancellation and stale-result protection. Enablement and individual connected-account grants have separate controls and authoritative readback. A successful reload clears its earlier error. New toggles use the existing green switch color in both themes. |
| Installation and OAuth (QA-15) | Installation remains on the detail page and continues into eligible account authentication/connection. Both detail and connection settings show waiting, reopen, expiry and cancel controls, refresh on foreground, and poll transient status. An ambiguous install/auth response is reconciled with the server before presenting failure or starting another session. |
| Plugin removal (QA-22) | A lost DELETE acknowledgement is reconciled against installed state; already-removed plugins return to the catalog. A real failure stays actionable beside the uninstall control. |
| Chrome approvals | Users can select profiles/sites using the server's exact profile/origin keys. Empty or oversized selections cannot be submitted. Permission approval is distinct from execution: retained cards show Approved, Running, Completed or Failed based on authoritative client state, including persisted receipts. |
| Auto Review | Native enablement and allow/block rule editing call the real server API, validate limits, check for already-changed rules before writing, and read back saved state. The server does not offer compare-and-swap; this is not an atomic concurrency guarantee. |
| Threads and search (QA-03–06) | Threads expose reply counts; actions inside a thread navigate into the selected nested thread. Message search opens the matching thread, routine search opens the actual routine editor, and link search opens its URL. Broken/cyclic ancestry is excluded. |
| Attachment limits (QA-11) | Nonempty files are checked before staging/upload: 25 MiB regular files, 200 MiB video; plugin ZIP packages use the server's 20 MiB limit. File imports check resource size before allocating full data. |
| Computer gestures (QA-12/18) | One native touch classifier handles tap, double tap, hold and drag, preventing a preceding double tap from consuming a hold. Trackpad movement moves the remote cursor; tap-then-drag drags remotely; two-finger tap right-clicks. Pinch/viewport motion and remote scrolling are coordinated. |

## Validation

Final coverage: **39 unique native UI cases passed, 57 core tests passed, the actual AppStore recovery program passed, and seven real production API checks passed**. All native UI runs use the dedicated iPhone 16 Pro Max / iOS 26.5 simulator. Fixtures run only on loopback and use synthetic data.

| Native UI coverage | Passing cases | Final evidence |
| --- | ---: | --- |
| Edge navigation | 11 | `EdgeBack.xcresult` |
| Conversations, search, approvals and rules | 9 | `Conversations-3.xcresult` |
| Plugin/settings lifecycle and access | 10 | Nine cases in `Plugins-3.xcresult`; account access rerun in `Plugins-5.xcresult` and `Plugins-6.xcresult` |
| Real remote computer | 7 | `Computer-2.xcresult` |
| Queued attachment identity | 1 | `PendingAttachment.xcresult` |
| Plugin configuration after installation | 1 | `PluginConfiguration.xcresult` |

`Plugins-3` retains one failed account-control attempt; that same case passed in the later focused runs. The final receipt merges the latest result for each test identifier and reports 39 passed, zero unresolved failures and zero skips. Screenshot review also confirmed the final green switch treatment and queued filename/size display.

- Core tests cover thread ancestry/counts, file limits, OAuth metadata/expiry and approval presentation/selection keys.
- The actual Swift AppStore acceptance program queues two conversations, removes the first, confirms the second delivers, and recovers the first attachment into an existing draft without data loss.
- Production HTTP API checks use a separate real server, disposable Postgres database and real authentication. They verify page limits, independent plugin enablement/account grants, policy persistence and a 26 MiB file rejection; synthetic rows are cleaned up and the policy is restored.
- Native plugin UI checks exercise retry, installation handoff, status return, reopen/cancel/expiry, lost acknowledgements, independent account access, settings persistence and empty search.
- Conversation UI checks exercise attachment holds/replies, visible/nested threads, search destinations, selected Chrome permissions, execution receipts and native rules persistence.
- Computer checks use the actual server and a real Chromium/X desktop. Browser event receipts independently confirm remote clicks, right-clicks, movement, keyboard and drag behavior.
- Final edge navigation checks cover text/photos/files, fast/slow gestures, keyboard-open drafts, cancellation, interior reply/hold, vertical scrolling and repeated navigation.

Evidence directory: `output/swift-backlog-0917/`. Failed preliminary runs remain there; final results are listed in `acceptance.json`. TestFlight packaging and source/signature verification are recorded under `output/testflight-native-23/`. All 77 release input hashes match the signed package.

## Remaining acceptance limits

- Real provider OAuth consent/callbacks were not completed. OAuth lifecycle tests use an inert loopback authorization page, not Google credentials.
- Physical iPhone haptic feel, APNs delivery/background removal, and arbitrary two-finger scrolling remain device checks. The automated computer suite covers two-finger tap and pinch, not synthesized continuous two-finger pan.
- The native computer viewer remains authenticated PNG polling rather than a streaming RFB VNC client.
- This pass does not close the separate group ordering/custom-avatar findings (QA-13/14), advanced connection clear-all/query-URL findings (QA-16/19), or pixel-perfect catalog/settings parity. The previously reported asset-download authorization exposure and production APNs deployment also remain separate server work.
