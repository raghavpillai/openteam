# iPhone QA and message performance — September 18, 2026

**Result: 145 distinct UI cases passed, one VNC gesture case failed, and one background-push case was skipped. Full app acceptance remains open.** Both message-performance workloads miss their CPU/memory targets.

This is a simulator, source, screenshot, and isolated live-server audit. It is not a claim that every iPhone configuration or external provider has passed. The original Grokbot screenshots and all failed/interrupted attempts remain in the evidence directory.

## Fixes made during this audit

- Message history now builds timestamp/thread metadata once per history change, groups bootstrap merges by channel, and retains stable layout for mixed content. Geometry observations use discrete thresholds instead of invalidating the conversation at every pixel. Older-page loading preserves the visible message.
- Custom group photos load, changed avatars invalidate their cache, and bot profiles preview/reset a custom photo correctly.
- Editing a group name/description no longer rewrites membership order; actual member edits preserve existing order.
- Advanced plugin configuration can explicitly clear all headers/environment values without confusing empty inputs with unchanged secrets. HTTP MCP URLs preserve query parameters while rejecting credentials/fragments.
- Desktop image/document/media previews, inline Markdown images, downloads, and legacy React Native thumbnails now include session authentication; a separate browser run passed both image aliases, inline Markdown images, Markdown preview and downloaded file content.
- Both asset URL aliases require the configured server session for GET, HEAD, and range requests. The previous public hash-only download exposure is closed in current source and the tested Linux image.
- Plugin sign-in emits one error haptic when its configuration save fails; the nested save no longer duplicates the sign-in error pulse.
- Simulator verification retains ad-hoc signing so tests exercise working Keychain behavior.

## Coverage and evidence

Evidence root: `output/swift-fullqa-0918/`. Final per-case acceptance and performance receipts are recorded there after the run. Earlier failures are not deleted or described as passes.

The audit covers HTTP login/re-auth and offline identity; animated sign-in/launch; inbox sections/search; edge-back, holds, replies, reactions and threads; queued recovery; Markdown/math/diagrams/widgets; file/photo preview, save/share/forward; plugin lifecycle and access/configuration; approval selection/receipts and native Auto Review rules; natural-language schedules; colors and keyboard backgrounds; haptic dispatch; native notification registration/read reconciliation; and real desktop input/recovery.

Live delivery tests use a separate Postgres database, synthetic QA bots, real model calls, and the built Linux server. They do not send messages to other people or mutate the owner's conversations. Asset authorization has 29 passing assertions against that server. A macOS Bun harness stopped answering even health/auth-config requests; its trace is retained, and live checks were moved to the Linux runtime used by the installation.

The per-case ledger is [final-ui-manifest.json](../../../output/swift-fullqa-0918/final-ui-manifest.json). It lists the exact accepted run for each case and does not count repeated phone/simulator runs twice. The final build was rerun through Grokbot visual references, seven screenshot states, edge-back, nested/search thread destinations and message haptics after the message-layout changes.

| Area | Evidence | Important limit |
| --- | --- | --- |
| Sign-in, re-auth, offline account, robot launch, main/chat functions | `OpenTeamNative-FullQA`, `Functional-Followup`, `PrivateImage-Acceptance`, `LaunchRobot-FullQA` | Debug simulator with independent fixtures |
| Holds, swipe replies, edge-back, nested threads, search | `EdgeBack-Stable-Final`, `Threads-Stable-Final`, `QAAudit-FullQA` | Physical-device gesture feel remains unmeasured |
| Markdown/widgets, photo/file previews and actions | `ContentFlowUITests`, `AttachmentReference-FullQA`, `RealServer-Linux`, `Rich-Linux-Final` | Real Linux message/attachment paths plus deterministic content fixtures |
| Plugins, account access, approvals and routine forms | `SettingsPluginAudit-FullQA`, `Approvals-Final`, `RoutineSchedule-FullQA` | External provider OAuth was simulated, not consented with Google |
| Haptic dispatch and preferences | `Haptics-FullQA`, `Haptics-Final`, `Haptics-Acceptance`, `Haptics-Stable-Final` | Tests count dispatched cues, not physical vibration |
| Push and desktop reads | `NativePush-FullQA`, `RealServer-Linux` | Background/APNs device acceptance remains open |
| Computer/VNC | `VNCValidation-Linux`, `Computer-Final`, RFB probe | Tap-drag failure and low frame cadence remain open |
| Colors/reference screenshots | `GrokbotVisual-Stable-Final`, `SevenReference-Stable-Final`, `SevenReference-iPhone16`, `Palette-Final`, `DarkReference-FullQA` | Functional screenshot capture is not a pixel-parity assertion |
| Long message history | `Performance-StableCache`, `Mixed-Stable-Final` | Functional cases pass; CPU/memory acceptance targets fail |

Core validation: 59 Swift cases, 278 shared client cases, 18 push service/transport cases, and 8 asset-route/semantic cases passed. The actual AppStore queue-recovery program also passed. Desktop compatibility has 429 passing unit cases and one existing skip after the formatting-sensitive media assertion was corrected; its browser check independently verified authenticated image/Markdown/download behavior.

## Visual findings

The original dark reference and native captures share flat backgrounds `#141414`, cards/assistant bubbles `#202020`, and user bubbles `#5C5C5C`. See the [original/native comparison](../../../output/swift-fullqa-0918/seven-review-iphone16/review.html) and its `flat-colors.json` for original/native captures and samples.

There are still visible differences. The home system context menu is darker in the native capture. Settings organization differs, including self-hosted account/server information and the location of additional preferences. OpenTeam uses its own robot artwork. Some attachment-menu wording differs. A JPEG screenshot cannot establish an exact material alpha; content behind the glass, native scroll-edge effects and OS settings all affect the result. This is not pixel-perfect parity.

## Open acceptance items

- **High-priority message performance:** the 1,000-message eager view retains about 626 MB; 200 mixed messages retain about 296 MB. Both exceed the initial 180 MB target. Caching metadata did not materially improve the stress workload. A bounded/recycled message renderer is still needed, with tall-message, WebKit-height, quote-jump and older-page regression coverage.

- Physical iPhone APNs delivery, background removal after a desktop read, haptic feel, microphone/camera permissions, and frame-rate/hitch acceptance. No physical device is connected. The simulator background-notification callback case is explicitly skipped; the live foreground read-sync check is separate evidence.
- Real external-provider OAuth consent/callbacks. Fixture lifecycle tests are not a Google authorization test.
- Native computer viewing still uses approximately one PNG frame per second, rather than streaming RFB. The separate real RFB probe passed eight controls/security/recovery checks but failed its frame-cadence threshold (two distinct frames in three seconds).
- Trackpad tap-then-drag did not produce a pressed-button move in the small-iPhone automation run. Direct touch/drag, repeated holds, pointer movement and two-finger right-click are separately tested. This gesture remains open pending correction or device timing verification.
- Complete settings/catalog/menu visual parity and device-specific accessibility/large-text acceptance remain follow-up work.

## Performance methodology

The before/after workload uses the same iPhone 16 Pro Max/iOS 26.5 simulator on the same host, Debug builds, three recorded samples plus warm-up, and six identical drag gestures per sample. It covers 1,000 text messages and 200 mixed messages including 20 complex documents. Acceptance also checks typing, older-page position, rich-document settling, and incoming messages while reading history.

CPU/wall measurements include XCTest accessibility work. Small desktop validation jobs also ran on the host during the final benchmark, so CPU differences should be treated as approximate rather than isolated microbenchmarks. Memory refers to the app process and excludes WebKit subprocesses. These comparisons do not establish physical-device FPS or a hitch-free scrolling guarantee. The checked-in performance scheme and budget/report script make regressions repeatable. The performance scheme is intentionally separate from the default functional suite; a passing UI test does not mean the memory/CPU budget passed. Lazy-layout prototypes were rejected after tall-message and mixed-document stress tests exposed UI freezes; their faster measurements are not release results.

To repeat the stress test, start `scripts/parity-server.ts` with `SWIFT_PARITY_PORT=19996`, then run the `MessagePerformance` Xcode scheme on the same device/configuration. Use `scripts/message-performance-report.py` to compare passing benchmark logs and enforce the checked-in targets.

### Measured results

| Workload | Peak app memory, before → after | App CPU per six-drag sample, before → after | Automation wall time, before → after |
| --- | --- | --- | --- |
| 1,000 text messages | 615.7 → 625.9 MB | 152.1 → 149.7 s | 155.2 → 151.8 s |
| 200 mixed messages | 293.9 → 296.2 MB | 12.6 → 13.0 s | 27.5 → 28.6 s |

These small differences do not establish a performance improvement. All four initial CPU/memory targets fail. The CPU metric includes the app servicing expensive accessibility snapshots between gestures; it is not the duration of a finger swipe. The targets are initial acceptance goals, not a previously achieved production baseline. Receipts: `performance-final.json` and `performance-final-report.log`.

The final receipt combines the passing text case in `Performance-StableCache` with the passing mixed case in `Mixed-Stable-Final`. The first mixed case raced a disappearing Latest button; its samples are explicitly excluded. Final mixed testing waits for document heights to settle before measuring.

## Local installation

The main installation was backed up, migrated and upgraded to the tested September 18 server/worker/computer images. All 39 channels, 352 channel messages and 236 runs match the migration rehearsal. Both HTTP and HTTPS health checks return 200; anonymous asset requests return 401 on both aliases. The worker has APNs signing configuration for the existing `dev.openbot.mobile` TestFlight app. Delivery is not yet device-verified.

Connect with `http://100.94.42.50:8787` or `https://office-mac-mini.tail658346.ts.net:10000` while the phone is on Tailscale. Deployment receipts: `local-deployment.json` and `main-server-postdeploy.json`. The isolated live QA server, worker, computer, database and migration rehearsal database were cleaned up after testing; the main installation stays running. Backups are private under `~/.openteam/backups/native-qa-0918/`.

## Internal test build

Native **0.0.1 (25)** was signed, validated, uploaded, processed as `VALID`, and assigned to **Team (Expo)**. Its testing notes disclose large-history memory, VNC and physical-device limitations. This is an internal migration beta, not full production acceptance.

The exported IPA passed signature/profile, HTTP ATS allowance, production APNs topic, notification extension, upgrade Keychain identity, bundled robot artwork and absence of Debug-only testing paths checks. Build sources still match their pre-archive hashes. Receipts: `output/testflight-native-25/verification.json`, `release-inputs.json`, `apple-processing.json`, and `distribution.log`.
