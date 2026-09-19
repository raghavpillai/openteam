# Native system QA

**Push follow-up:** [Native push implementation and acceptance](NATIVE-PUSH.md) addresses the QA-01 implementation gap and fixes QA-08. Signed-device APNs delivery remains unverified; the other 20 findings are unchanged. The audit evidence below describes the pre-fix state.

September 16, 2026. This pass checks the production boundary as well as simulator controls. The review and original logs/result bundles are under `output/swift-full-qa-0916/`.

**Current acceptance status:** the subsequent [full-app audit](QA-AUDIT-0916.md) and [settings/plugin follow-up](SETTINGS-PLUGIN-AUDIT-0916.md) record 22 open issues. The original audit's six targeted UI checks fail; the follow-up has four failures and four passing workflows. The passing runs below cover specific workflows and do not establish release readiness.

## Environments

- The default `OpenTeamNative` suite uses two independent loopback schema fixtures. It covers native navigation, mutation receipts, retained input, error recovery, chat, media, forms and robot behavior.
- `LiveComputer` uses a fresh Linux desktop with actual X11, Chromium and the current `ScreenBroker` source. The native app's screen routes are forwarded to it by the fixture. Browser JavaScript records trusted OS input; this is not an image pretending to be a desktop.
- `LiveBackend` uses a separate PostgreSQL database, the current production API and wake worker, and a loopback proxy that can lose connections/acknowledgments. Only the model/computer inference boundary is deterministic. Scheduled automation calls the real `WakeParent` tool, and the resumed parent calls the real `SendToUser` tool.

All state is synthetic and disposable. These tests do not use personal accounts or an existing production database. The helper ports are 20002 (PostgreSQL), 20003 (desktop), 20004 (desktop fixture), 20005 (production API), 20006 (model boundary) and 20007 (fault proxy).

## Optional live checks

`apps/computer/test/fixtures/native-viewer-bridge.ts` (from the repository root) must run inside a disposable OpenTeam computer image with `SWIFT_QA_DISPOSABLE_COMPUTER=1`. Copy the current `apps/computer/src` and test sources into the image before running; the image's prebuilt runtime is not sufficient evidence of the edited source. Expose its port 8790 only on host loopback port 20003. The bridge launches its own inert browser page and destroys its own desktop on termination. It lives with the computer runtime so the native app's scripts do not import another application's implementation.

Start the native forwarding fixture on the host:

```sh
SWIFT_PARITY_PORT=20004 SWIFT_QA_LIVE_SCREEN_URL=http://127.0.0.1:20003 \
  bun apps/mobile-swift/scripts/parity-server.ts
```

For the production backend, create a fresh PostgreSQL database named `swiftqa_live` with the disposable credentials/port in `scripts/live-backend-qa.ts`, apply the current Prisma schema, and run that script from the repository root. It launches current source server/worker processes and stores only disposable files under the QA output directory. Do not repoint it at a real account database. The standard integration suites use a different fresh database (`swiftqa`) on the same disposable PostgreSQL instance.

Run either optional scheme on a booted simulator, using a new result-bundle path:

```sh
xcodebuild -project apps/mobile-swift/OpenTeamNative.xcodeproj \
  -scheme LiveBackend \
  -destination 'platform=iOS Simulator,id=<simulator-udid>' \
  -derivedDataPath apps/mobile-swift/.build-ios -parallel-testing-enabled NO \
  -resultBundlePath output/native-live-backend.xcresult CODE_SIGNING_ALLOWED=NO test
```

Use `LiveComputer` in place of `LiveBackend` for desktop input/recovery. Avoid running multiple suites against the same fixture or simulator at once. The backend test waits for the actual five-minute schedule with the app terminated; it does not alter the database clock or manually dispatch the scheduled execution. The routine is paused after its result is observed. Inspect the summary's total failures, including earlier runner launches, rather than a trailing “0 tests passed” after an XCTest restart.

## Fixes exercised

- URL path encoding preserves the hyphens in production UUIDs, while reserved and Unicode characters remain escaped.
- Plain `type: text` messages support hold-to-reply and swipe-to-reply. The resulting inline reply retains the original channel and parent message.
- Rapid native gestures are serialized without disabling gesture recognition between requests. Failed or invalidated inputs stop the queued batch; they are not automatically replayed.
- Concurrent desktop inputs share a readiness barrier so health checks cannot reorder their input queue.
- A stale screen remains visible with an explicit label while interaction stops. Frame refreshes cannot overwrite a newer control lease.
- Routine run retries reuse their request ID after an ambiguous response. Accepted executions survive a failed history refresh, with separate retry controls.
- Private-skill save feedback is at the top of the form, where it remains reachable on a compact phone with its keyboard open.

## Evidence and limits

`scripts/export-system-review.py` accepts successful XCTest bundles, copies their original named screenshots, records SHA-256 hashes, and includes actual backend timestamps/receipts. It rejects unresolved failures/skips and requires an observed completed scheduled execution. An optional earlier broad bundle retains its original failure count; every earlier failed case must pass in a later supplied bundle, and failed-case screenshots are excluded. The review also carries forward the explicitly labeled supplied-reference comparisons.

Grokbot's [mobile documentation](https://docs.x.ai/grok-bot/mobile) guides the shared-desktop and background-routine behavior. The ten additional dark photos now cover fullscreen computer, startup, keyboard, group search, profile, composer and recording states. Their comparison is exported by `scripts/export-dark-review.py`. Native Liquid Glass remains on individual controls; the desktop robot artwork and motion remain ours. The recording screenshot uses an explicitly enabled simulator-only synthetic AAC source: this Mac mini has no microphone input. A separate UI check verifies the actual microphone-unavailable error and that text input remains usable. Device/release builds do not include that audio fixture.

This is not full production acceptance. Native APNs is still missing; real provider/OAuth accounts, advanced plugin authoring, every card conflict, multi-account races, and signed-device camera/microphone/VoiceOver/background performance need separate acceptance. Keep the RN iOS client available during migration.

## Dark-reference follow-up

The current native interface uses a black fullscreen desktop, floating header/clipboard/keyboard controls, ordered direct keyboard input, searchable bot selection before group naming, a compact profile character picker and direct routine entry. The recording bar has three pills with a fixed-width timer and waveform. The same retryable transcription path retains recordings on failure.

Run the dedicated loopback fixture on port 20009, then the `DarkReference` scheme. This optional suite expects the QA host without a microphone; do not treat its synthetic recording as physical microphone acceptance. `Visual-Verified-2.xcresult` contains the seven passing final visual checks and all ten reference states. `Native-1.xcresult` contains 26 passing default UI checks on iPhone 16e after the main interface changes; `RefinedProfiles.xcresult` contains four subsequent focused checks. The real-desktop right-click failure in `LiveComputer-Final.xcresult` remains an open intermittent finding even though `LiveComputer-AuditRepeat.xcresult` passed unchanged.

The ten-reference review keeps all original JPEGs and native PNGs, capture provenance and hashes. Detail crops are labeled, proportionally resized views of those originals. Matching neutral samples on the first capture pass were 52/255 versus 51/255 for the home button, 31/255 versus 32/255 for the computer button, and 51/255 in both composer interiors. These are rendered-color samples, not inferred material opacity or whole-screen pixel equality.
