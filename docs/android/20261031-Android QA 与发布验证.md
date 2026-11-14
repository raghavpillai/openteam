# Android QA 与发布验证

This plan turns the existing iOS validation surface into an Android release gate while the Android feature owners finish parity work. The iOS schemes remain the behavioral reference: `MessageParity` and `QAAudit` cover functional regressions, `MessagePerformance` and `MotionPerformance` cover interaction cost, and `Acceptance`, `LiveHTTP`, and `RealServer` cover installation and server boundaries.

## Execution tiers

1. **Every change:** validate `docs/android/parity-matrix.json`, run JVM tests, assemble the unsigned debug APK, and publish the generated parity report as a CI artifact.
2. **Android emulator:** run the Compose smoke suite on a fixed API 35 profile. Check cold launch, sign-in controls, directory navigation, history, draft entry, send state, back navigation, rotation, keyboard insets, and deep links.
3. **Physical device:** repeat the smoke suite on the minimum supported API and one current API. Add permission prompts, interrupted network, background/foreground, process death, encrypted draft recovery, attachment providers, and notification behavior.
4. **Release candidate:** run the security and performance checks below, verify the signed AAB/APK, record SHA-256, install the exact artifact, and perform an internal-track staged rollout.

## Performance checks

Use a fixed device model, API level, display scale, battery state, and release build. Capture three cold starts and five warm starts, then record median and worst-case values for launch to usable directory, directory refresh, opening a 1,000-message history, scrolling mixed rich messages, keyboard-to-composer readiness, and send acknowledgement. Capture frame timing, CPU, memory, and jank with Android Studio Macrobenchmark or `adb`/Perfetto traces. Compare against the iOS scheme results from the same fixture size; simulator numbers are comparative evidence only.

Do not promote a candidate with a new ANR, sustained input jank, unbounded history memory growth, a dropped draft after process death, or a send transition that loses its client ID. Keep traces and screenshots in CI artifacts or the release record, not in the repository.

## Security checks

- Release manifests must use HTTPS endpoints by default, keep cleartext disabled for production, and expose only the intended deep-link scheme.
- Verify server discovery and redirect validation reject credentials in URLs, unexpected hosts, and unsafe schemes.
- Confirm session tokens, passwords, attachment URLs, and request headers never appear in logs, crash reports, screenshots, APK resources, or test fixtures.
- Verify drafts and session material use Android Keystore-backed encryption, are scoped by server and account, survive only the intended restart path, and clear on sign-out or account change.
- Check exported activities, backup policy, network security configuration, WebView/provider boundaries, and PendingIntent mutability before signing.
- Run dependency and APK scans, inspect manifest permissions, verify the signed artifact with `apksigner`, and compare the recorded digest after upload.

## Release evidence

The release record should include the commit and version, Gradle/JDK/SDK versions, device matrix, parity report, JVM and connected-test results, performance traces, security scan results, signing certificate fingerprint, AAB/APK SHA-256, and Play internal-track installation result. Credentials and keystore contents stay outside the repository. A failed critical security row or an unclassified parity row blocks promotion until the owner and evidence are recorded in the matrix.

Run `bash scripts/android/release-gate.sh all` for the reproducible release gate. It validates credential-free parity, assetlinks template shape, live contract routes, FCM payload behavior, manifest/dependency declarations, artifact digests, APK/AAB signing tools, device availability, performance-baseline input, and Play-service-account/tool availability. It reports artifact, signing, device, performance, and Play checks as `PENDING` when the required external input is absent; use `ANDROID_RELEASE_GATE_STRICT=1` in a release job to fail on any unavailable gate.

The task-24 run on the current source passed the credential-free parity, assetlinks, live-parity contract (11 checks), FCM payload (4/4), App Links declaration, and dependency declaration checks. It reported `PENDING` for development cleartext hardening, APK/AAB artifacts and digests, signing verification, device/performance baseline, and Play service-account access. Strict mode exited 1 on those unavailable external gates, as designed. No credentials, signing material, release artifact, device profile, or Play access was present in this workspace.

## Current acceptance state (2026-10-31)

The current-source Android-capable runner reported `:mobile:androidApp:assembleDebug` passed, `:mobile:androidApp:testDebugUnitTest` passed 17/17, and `:mobile:androidApp:connectedDebugAndroidTest --rerun-tasks` passed 6/6 on V1916A. Both the QA parity flow and the shell-owned `PrimaryWorkflowTest` passed. On this workstation, the same Gradle commands stop before execution because no Java runtime is installed; the runner results above are the authoritative build evidence for this pass.

Full Android parity is still open. The board-completed task-12 and task-13 implementation checkpoints are recorded, and current-source compile/connected verification is green, but live/device and external-service acceptance evidence is not. Live-server authentication and delivery, release-device performance traces, dependency/APK scans, signed artifact verification, Play internal-track installation, FCM/VNC/assetlinks, and the current cleartext/deep-link security review still lack release evidence. The parity matrix records each blocker and must remain open until its evidence is attached.

Tasks 8, 9, and 10 are currently marked completed, and tasks 12 and 13 have board-completed implementation checkpoints. The current-source additive shared synchronization, live feature gateway, rich-content, and platform paths compiled in `assembleDebug`, passed the 17/17 JVM suite, and passed the 6/6 connected suite; the shell harness blocker is resolved. Live synchronization still needs an isolated server run, while rich-content/attachment, OAuth, voice/file, search/indexing, FCM, VNC, and assetlinks acceptance remain open. Because these tracks add code across shared Android data/UI/platform and test source sets, every increment must rerun assemble, JVM, and connected compilation; any future additive-source compile failure blocks parity acceptance.

## Second-round acceptance (tasks 14–17)

The second-round matrix maps representative checks for live synchronization and delivery contracts, rich chat rendering and actions, feature settings/plugin gateway flows, deep links, voice/share entry points, and account isolation. Tasks 14–17 are board-completed. Pre-fix Android-capable evidence recorded assembly plus 22 JVM tests with 21 passing and one failure at `ChatProjectionTest.kt:38` (`ChatProjectionTest.chatMessageRetainsRichMetadataAssetsReactionsAndContext`, expected null but received `Choose a path`). The expectation is fixed in current source, but the post-fix JVM rerun cannot start because no Java Runtime is installed and `JAVA_HOME` is unset. The last valid connected result remains 7/7 on V1916A at XML timestamp `2026-10-31T11:13:05`, including `RichMessageRendererTest` 3/3, `AndroidParitySmokeTest` 2/2, and `PrimaryWorkflowTest` 2/2. Live-server, release performance/security, FCM/VNC/assetlinks, the pending post-fix JVM rerun, and additive compile evidence remain release blockers.
