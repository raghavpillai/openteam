# React Native → Swift functional audit — September 20, 2026

**This document records the original RN-to-Swift audit and its follow-up scope.** Most primary workflows were present; the original findings identified migration, history navigation, group speaker identity and message-card differences. The Account/Plugins navigation failure reported during this audit is fixed separately in build 31.

Baseline: `c0f53a3ba7fc0f33b4de8d11d75cebe688e8a4b4`. Compared all nine Expo routes, their reachable components/state operations, shared client/product logic, and the corresponding Swift app/core implementations. This is a source-level functional audit plus focused fresh tests; it is **not** a new full physical-device or pixel-parity sign-off. Earlier reports are historical evidence, not proof that today's implementation passed every scenario.

## Follow-up implementation

The September 20 message follow-up implements the requested changes to M1–M9, subject to the validation record in [Message parity and performance QA](QA-MESSAGE-PARITY-0920.md). M1 was clarified as durable Swift drafts when switching chats/relaunching, rather than importing the old RN storage. M4 is an internal transport queue only: no user-managed queue screen. M10 remains intentionally unsupported at the user's request. M11/M12 were outside this selected follow-up.

The original findings below preserve the audit baseline; they are not a statement that M1–M9 remain unfixed. Updated implementation and test evidence supersede the corresponding baseline rows.

## Original differences at the audit baseline

Priority describes user impact, not whether a feature should be restored against an explicit product decision. File paths below are repository-relative. Line numbers refer to the audit baseline, except SettingsView which changes in this pass.

| ID | Priority | Difference and user impact | Source evidence / acceptance check |
| --- | --- | --- | --- |
| M1 | P1 | **Upgrade does not import unsent React Native drafts, queued sends or their staged attachments.** They remain in the old storage for rollback but are unavailable in Swift. Re-auth deliberately removes local data, so it must not be presented as a migration remedy. | `Sources/Core/LegacyMobileUpgrade.swift:5` imports only eight preference/session keys; `Sources/App/LegacyInstallation.swift:18`; README explicitly documents the omission. RN `src/drafts.ts`, durable-send storage and attachment staging contain additional data. Acceptance: upgrade an actual RN installation with text, reply, file-only and failed/offline drafts, preserving account scope and avoiding duplicate sends. |
| M2 | P1 | **No forward pagination through an older search/context window.** Swift merges a fetched context window and latest history into one sorted collection, without retaining `hasNewer` or a cursor to bridge their gap. A search hit can be followed visually by much newer content until enough older pages are loaded. | Swift `AppStore.swift:463–499,817`, `Core/Models.swift:189`; RN `app/chat/[channelId].tsx:635–640,824,917` uses `loadLaterMessages` and `jumpToLatestMessages`. Acceptance: open a hit hundreds of messages back, scroll both ways with contiguous sequence coverage, then jump to latest. |
| M3 | P1 | **Ordinary group replies omit the bot's speaker name.** Differently authored messages have the same assistant presentation; group header membership does not identify who wrote an individual message. | RN route `:695–720` resolves `groupSpeaker`, and `message-bubble.tsx:470` displays it. Swift `ChatView.swift:497–605` displays directed A2A metadata but no normal `senderBotId` label. Acceptance: interleave three bots and verify visible and VoiceOver author identity. |
| M4 | P2 | **Queued sends cannot be cancelled back into the composer for editing.** Swift offers discard and failed-send retry; recovery to another draft is available only when the original channel is unavailable. | RN route `:405,742` calls `recoverCancelledMessage`; Swift `ChatView.swift:820`, `OutboxView.swift:43–57`, `AppStore.swift:630`. Acceptance: cancel a queued reply with files, edit it and resend without losing files, reply target or deduplication safety. The removed sending clock is an intentional visual change, not this missing action. |
| M5 | P2 | **The dedicated A2A exchange viewer is missing.** Directed messages render a plain label, but tapping through to a focused read-only bot-to-bot exchange is unavailable. | RN `a2a-exchange-sheet.tsx` and route `:299,950`; Swift `ChatView.swift:508–526`. Acceptance: open each peer exchange and an A2A search result without mixing unrelated messages. |
| M6 | P2 | **User forms lack “Open the screen” escalation and detailed completion/failure receipts.** Basic fields, validation, prefill, submit and dismiss exist. Swift does not offer the RN fallback to the computer or display per-field fill results and page/domain-change outcomes. | RN `user-form-card.tsx:65–78,124,313`; Swift `RichMessageCard.swift:313–390` has only Submit/Dismiss and generic completed-state text. Acceptance: escalate a form, then exercise partial fill, moved page, domain mismatch and successful submission. |
| M7 | P2 | **Secret requests ignore the canonical `secretRequest` metadata and omit storage-scope wording.** Submission exists, but Swift reads only `secret`; some valid requests fall back to “Secure input” without their label/instructions. Named bot secrets also lack RN's explanation that they are available to all users of that bot. | Shared `rich-messages.ts:203` and server `rich-message-service.ts:301` accept `secretRequest ?? secret`; Swift `RichMessageCard.swift:279`; RN `rich-message-card.tsx:629–722`. Acceptance: both metadata aliases, personal/bot scope and provided-state receipts, without disclosing values. |
| M8 | P2 | **Routine-change messages lose their event presentation and navigation.** RN renders centered create/update/delete events and opens nondeleted routines. Swift's message timeline has no corresponding routine-event action. | RN `message-bubble.tsx:366–394` and route `:761`; Swift `Core/MessageTimeline.swift` plus `ChatView.swift:497`. Acceptance: open created/updated routines from history, with deleted events remaining read-only. |
| M9 | P2 | **Reaction counts are omitted.** Swift reduces reactions to unique emoji buttons, losing how many people reacted and the RN count in the accessibility label. | RN `message-bubble.tsx:48–90`; Swift `ChatView.swift:579–590`. Acceptance: multiple actors using the same emoji, selected state, toggling and spoken count. |
| M10 | P2 | **Legacy cloud-agent / bot-template cards do not render as cards.** Their title/avatar/status/description presentation is absent. | Shared `rich-messages.ts` recognizes cloud-agent aliases and bot-template; RN `rich-message-card.tsx:108,354`; Swift supported types at `RichMessageCard.swift:162` omit them. RN's optional open/publish callbacks are not supplied by its chat route, so this is a rendering gap, not a claim that working RN publishing actions were lost. Swift's separate review-action template publishing is implemented. |
| M11 | P2 | **Empty-query search ignores the selected category.** Swift always lists visible channels when query is empty and never requests category results. RN can browse a category without entering a query. | Swift `HomeView.swift:578,630`; RN `app/search.tsx:309–358`, client search. Acceptance: empty Files, Routines, Bots and Groups categories show the correct result types or empty state. |
| M12 | P3 | **No per-query/category search result cache.** Returning to a query or category clears results and fetches again. RN reuses results for the current snapshot cursor. | RN search `:288–314,337`; Swift `HomeView.swift:627–651`. RN `searchClientSnapshot` is a fixture helper: this audit does **not** claim RN has general offline full-text search. |

## Original performance and acceptance gaps

| Area | What current source/evidence establishes | What remains |
| --- | --- | --- |
| Large histories | Swift renders chat and thread rows in eager `VStack`s and retains loaded message pages. RN uses a tuned `FlatList` and bounded history management. Historical September 18 workloads exceeded the project's CPU/memory targets (about 626 MB for 1,000 text messages and 296 MB for mixed documents). | Fresh optimized profiling on a physical phone, bounded retained history and a stable layout/virtualization solution. Historical measurements are not new measurements of build 31. |
| Typing with a large cache | `ComposerView` draft changes call `AppStore.saveDraft` → synchronous `persist`; `DiskStore.save` JSON-encodes and atomically writes the whole saved state on the main actor. RN debounces draft storage separately. | Measure typing latency as the cache grows; move/coalesce persistence without sacrificing durable sends. Code establishes the synchronous work, not an exact hitch duration. |
| Computer gestures | Native tap, hold/right-click, touch/trackpad modes, keyboard, clipboard, takeover, pause and reconnect exist. The prior small-iPhone trackpad tap-then-drag case failed to emit a pressed-button move. | Reproduce/correct that specific gesture and verify timing on hardware. No new gesture pass was run during this panel fix. |
| Computer frames | Current Swift uses authenticated multipart JPEG `/stream`, newest-frame buffering and PNG fallback only for unsupported endpoints. | Verify the deployed server stream and physical-device frame pacing. The old report's claim that current Swift only polls PNG at 1 FPS is stale. This is also not a missing RN RFB client: the RN screen route used screenshot polling. |
| Push | Registration, APNs environment, read cursors, delivered-notification removal, cold taps, badges, logout cleanup and notification extension are implemented. | Real iPhone background/terminated-app delivery and desktop-read dismissal. Simulator payload tests cannot certify APNs delivery or iOS background scheduling. |
| Voice, photos and haptics | Native recorder/transcription request/recovery, photo/camera permission paths and haptic dispatch are implemented; earlier automated/isolated-live checks exist. | Physical microphone transcription, camera capture, denied permissions and felt haptics. Synthetic audio and logged dispatch are not hardware acceptance. |
| OAuth | Installation/authentication continuation, account permissions, cancellation, reopening, expiry and lost-response recovery exist in current source. | Real Google/other provider consent and callback through the user's deployed server. Fixture authorization is not external-provider QA. |
| Visual/accessibility | Native light/dark palette, glass, keyboard background, animated robot, message arrival, edge-back exclusion, centered headers and group cutouts have dedicated implementations and prior evidence. | No new blanket 1:1 visual claim. Check original recordings on equivalent OS/display settings, Dynamic Type, VoiceOver and Reduce Motion on hardware. |

## Coverage matrix at the audit baseline

“Present” means a reachable implementation was found on both sides; it does not certify every device/provider combination. Gaps above qualify the corresponding row.

| Workflow | Swift comparison | Main implementation |
| --- | --- | --- |
| Welcome, animated bots, server/IP entry, HTTP/HTTPS, URL validation | Present; welcome copy and implicit server label reflect requested changes | `SignInView`, `AuthBotField`, `LaunchRobotView`, Core `API` |
| Session validation, auth modes, expired-session recovery, reconnect, persisted account name | Present | `AppStore`, `SecureSession`, `AccountConnectionView` |
| Account, Plugins root navigation | **Fixed this pass** with native grouped list rows; previously reproducible dead tap regions | `SettingsView`, `SettingsNavigationUITests` |
| Re-auth, local-data wipe, sign-out and failures | Present; red Re-auth intentionally replaces separate server/sign-in actions | `AppStore`, `LegacyInstallation`, `NativeNotifications` |
| RN installation upgrade | Preferences and bound session present; unsent-content import missing (M1) | `LegacyMobileUpgrade` |
| Main/empty list, bot/group creation, selection, refresh | Present | `HomeView` |
| Bot identity/instructions/avatar/reset/duplicate/template export | Present | `ConversationDetails`, `RobotIdentityPicker` |
| Group members/order/name/description/custom-avatar preservation | Present; per-message authors missing (M3) | `ConversationDetails`, `GroupChannelAvatar` |
| Hide/show/delete, pins, custom sections, collapse, rename/reorder, unread | Present; Unassigned hidden when no custom sections, as requested | `HomeView`, `SidebarSettingsView`, `AppStore` |
| Group composite avatars, cutouts/+N, centered header, recent responder desktop | Present | `GroupChannelAvatar`, `ChatView`, `AppStore.computerBot` |
| Live text sends, event updates, retries and client-ID reconciliation | Present | `AppStore`, Core delivery/message merge |
| Offline queue, staged files, failed send recovery, deleted-channel isolation | Present; cancel-to-edit gap (M4) | `AppStore`, `OutboxView`, Core persistence |
| Drafts/replies on native relaunch | Present; persistence performance concern above | `ComposerView`, `AppStore`, `DiskStore` |
| Latest/older history, timestamps, unread boundary, initial spinner | Present; context continuity gap (M2) | `ChatView`, `AppStore` |
| Thread discovery, nested threads, replies, counts, focused thread navigation | Present; depends on available history/context | `ThreadView`, `ThreadProjection` |
| Message hold/copy/select/reply/forward/react/mark unread | Present; reaction count gap (M9) | `MessageRow`, `MessageActionsView`, `NativeTextSelection` |
| Edge-back versus swipe reply and keyboard dismissal | Present with explicit gesture arbitration | `MessageGestures`, `ChatView`, `NativeDesign` |
| Bot/group/plugin/skill mention suggestions | Present | `ComposerView` |
| Markdown paragraphs/emphasis/code/links, tables, math and Mermaid | Present through native simple text and bundled offline rich-document renderer | `RichMarkdownView`, `Resources/MessageRenderer.html` |
| Single/multi/custom-choice widgets and completed selections | Present | `RichMessageCard` |
| Secure requests and completed receipt | Present with metadata/scope gap (M7) | `RichMessageCard` |
| User form prefill/typed fields/required validation/vault toggle/submit | Present; escalation and detailed receipts missing (M6) | `RichMessageCard`, Core `FormValidation` |
| Computer handoff accept/skip/resume | Present | `RichMessageCard`, `ComputerView` |
| Email/Slack drafts, review actions, template publish/import/unpublish | Present | `RichMessageCard` |
| Legacy cloud/template cards, A2A exchange viewer, routine events | Partial/missing (M5, M8, M10) | See findings |
| Photos/file/camera selection, limits, pending file identity | Present; 6 files, normal/video size validation | `ComposerView`, `PendingAttachments`, Core attachment validation |
| Authenticated images, full-screen gallery/filmstrip/zoom/caption | Present | `AttachmentMedia` |
| File preview/unsupported types, system share/save/forward | Present | `NativeFilePreview`, `AttachmentMedia` |
| Voice recording, pause/stop/send, transcription, cancellation/recovery | Present; hardware acceptance open | `VoiceRecorder`, `ComposerView` |
| Search categories, errors/retry, message/thread/routine/file/link destinations | Present with context/category/cache gaps (M2, M11, M12) | `SearchView`, `AppStore.open` |
| Routine list/create/edit/delete/pause/run/history/time zone | Present, including natural-language/dropdown schedule choices | `RoutinesView`, `RoutineScheduleFields` |
| Routine conflicts, multiple/event trigger preservation | Present; no forced cron editor | `RoutinesView`, Core routine models |
| Tool approval decisions, Chrome site/profile choices, retained receipts | Present; older missing-feature report is stale here | `ApprovalCard`, `RichMessageCard` |
| Auto Review rules management | Present natively; no longer desktop-only | `AutoReviewRulesView` |
| Plugin catalog/search/category/install/uninstall | Present; fresh install/error recovery test passed | `PluginsView` |
| Bot enablement and independent account grants, paginated access controls | Present, including pagination validation | `PluginsView` |
| Plugin connect/auth/cancel/reopen/expiry/lost ack/disconnect/restart | Present; external provider acceptance remains open | `PluginConnectionView`, `PluginConnectionActions` |
| Connection accounts add/rename/remove, typed/secret config, tools/policies/test | Present | `PluginConnectionView`, `PluginManagementViews` |
| Plugin sources add/edit/remove/refresh, private skills/grants/files | Present | `PluginManagementViews` |
| Packages import URL/ZIP/files, export, draft save/install/delete, updates/rollback | Present | `PluginManagementViews` |
| Custom HTTP/stdio MCP connections | Present | `PluginManagementViews` |
| Computer startup/frame/error recovery, orientation/scaling, keyboard/clipboard | Present; stream and gesture acceptance gaps above | `ComputerView`, `ComputerSurface`, `ComputerKeyboard` |
| Push settings, per-bot notifications, read synchronization | Present; physical-device gate above | `NativeNotifications`, notification extension |
| Appearance/accent/haptics preferences, Help/feedback/server status | Present; native grouped root panel now used | `SettingsView`, `NativePreferencesView`, `NativeHaptics` |

## Intentional differences, not omissions to restore

- Mobile Memory, hype and confrontation controls were explicitly removed at the user's request.
- Separate Account “Sign in” and “Change server” actions were replaced by red Re-auth that wipes local state and returns to sign-in.
- The chat bot-run Stop icon and sending clock were deliberately removed. Recording still needs its stop control.
- The current OpenTeam robot artwork is the selected product identity; GrokBot's shapes are a reference for layout/behavior, not an unqualified asset-replacement instruction.
- RN's “Report message” path displays a self-hosted-unavailable placeholder. It is not a functioning reporting capability lost in Swift.
- RN timezone/language informational rows should not be mistaken for an implemented in-app editor. Swift exposes the applicable OS settings.
- Client-core/server APIs without a reachable RN mobile action are not counted as lost mobile UI.

## Fresh validation and evidence

- Swift Core: **79 passed, 0 failed**.
- RN mobile + client-core + product-core Bun tests: **407 passed, 0 failed**, 76 files / 3,261 assertions.
- Before-fix Settings coordinate tests: both Account and Plugins failed. This explains why an earlier element `.tap()` check could pass while a real tap on blank row space did nothing.
- After-fix coordinate checks: dark/light, small/large iPhone simulators, x positions 10%, 50%, 80%, 95%, back navigation, sheet close and reopen passed.
- Existing dark Account/Re-auth, plugin install/connection failure recovery, and invalid-server reconnect/sidebar save-retry tests passed.
- No full functional simulator suite, new live model/provider run, physical-device benchmark or APNs delivery test was rerun in this pass.

Evidence directory: `output/rn-swift-parity-0920/`, including source baseline, method inventory, test logs, failed/passing `.xcresult` bundles and actual screenshots. The audit's missing features are **findings, not fixes included in build 31**. Recommended order: migration safety and history continuity; group authors; forms/secrets; queue editing and message-event navigation; performance and physical-device acceptance.
