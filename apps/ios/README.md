# OpenTeam for iOS

The native SwiftUI iPhone/iPad client lives in `apps/ios`. The React Native app and
its Expo/Android build have been retired. Native notification-extension sources,
QA fixtures, asset generators, and the Xcode project are all owned here.

Debug installs as **OpenTeam Swift** (`dev.openteam.mobile.swift`) with an isolated
Keychain and `openteam-swift://` links. Release installs as **OpenTeam**
(`dev.openbot.mobile`), retaining the existing TestFlight app, notification and
Keychain identity, and `openteam://` links. Version, build number, bundle ID and
signing team are configured in `release.json`.

## Build and run

Use macOS with Xcode 26+ and Swift 6; the deployment target is iOS 18. Open
`OpenTeamNative.xcodeproj`, select the `OpenTeamNative` scheme and an iOS simulator,
and Run. Connect to your OpenTeam server using its reachable HTTP or HTTPS address.
The native target has no Expo, React Native or CocoaPods runtime dependency.

From the repository root:

```sh
bun install --frozen-lockfile
bun --filter @openteam/ios generate
xcodebuild -project apps/ios/OpenTeamNative.xcodeproj \
  -scheme OpenTeamNative -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath apps/ios/.build-ios CODE_SIGNING_ALLOWED=NO build
swift test --package-path apps/ios -c release
```

`generate` regenerates the checked-in project, shared robot artwork, the
notification avatar artwork, offline Markdown/KaTeX/Mermaid documents, and noVNC
viewer. Its JavaScript dependencies are pinned in this workspace's `package.json`.
Ordinary messages, chat navigation, composer and state are native Swift views.

## QA

The loopback parity server uses synthetic accounts and content, never a model or
connected service. Start it with:

```sh
bun apps/ios/scripts/parity-server.ts
```

The default port is 19997; override it with `SWIFT_PARITY_PORT`. The DEBUG-only
launch arguments `--ui-testing --server http://127.0.0.1:19997` use temporary QA
storage and do not persist a real login in Keychain.

Run the core, client-contract and default native UI checks against a booted simulator:

```sh
bash apps/ios/scripts/verify.sh <simulator-udid>
```

The script starts fixtures on ports 19997, 19992, 20070, 20122 and 20121.
The `VideoComputerParity` scheme requires a separate disposable live desktop backend.
`MigrationAcceptance` covers routines, edge gestures, attachments and the local
HTTP/HTTPS installation (fixtures 20032, 20043 and 20039). `MotionPerformance`
covers composer motion and history performance (fixtures 20070 and 19996); run
it after other simulator suites finish. Optional Xcode schemes cover
message motion/performance, widgets, settings, VNC, and reference captures. See
`Tests/UITests` and `OpenTeamNative.xcodeproj/xcshareddata/xcschemes` for the current
checks; optional live-server tests require their own isolated backend. For an
isolated `FunctionalFlowUITests` rerun, set
`TEST_RUNNER_FUNCTIONAL_FLOW_SERVER=http://127.0.0.1:<fixture-port>` when invoking
`xcodebuild`; the default remains port 19992.

For keyboard latency investigations, add `--trace-composer-latency` to a DEBUG
chat launch. After a real tap it saves `Documents/composer-latency.json` in the
app container, with touch/editing/keyboard timestamps and display-link samples.
`--composer-latency-control` opens a plain native multiline field for comparison;
tap its title to dismiss the keyboard. These probes are excluded from Release.
Record the simulator concurrently with `idb video --fps 120 --udid <udid> <file>`
and inspect actual frame timestamps and the reported screen refresh limit;
requesting 120 fps does not establish physical-device 120 Hz performance.

For real transcription, the `RealServer` scheme's
`RealServerUITests/testLiveVoiceTranscriptionAndDraftPreservation` uses
`scripts/real-server-qa.ts`. The retired React Native `--ios-app` transcription
harness is no longer supported. The optional `OpenTeamReference` scheme can still
capture a separately installed historical reference binary; building that binary
requires a pre-migration Git revision.

```sh
bun run ios:performance
```

This runs Release Swift history benchmarks. Simulator CPU, memory and gesture tests
do not certify physical haptic feel, production APNs delivery, microphone/camera
interruptions or iPhone frame rate. Historical screenshots/results remain local in
repository `output/`; they are not bundled with the app.

## Release

Increment `release.json`'s build number before each TestFlight upload, keep its
version in sync with this workspace's `package.json`, then regenerate the project.
The tagged release workflow uses native Xcode archive/export on macOS. Its signing
secrets and upload procedure are documented in [Releasing OpenTeam](../../.github/RELEASING.md).
`ci-testflight.sh` is for an ephemeral CI runner, not a developer's personal keychain.
Uploading an archive does not establish Apple processing or tester availability.

For local distribution, archive the Release scheme in Xcode using the configured
team and distribute the archive through Organizer. Both the app and
`OpenTeamNotifications` extension require matching provisioning profiles.

## Product boundaries

Voice recording transcribes into the draft; a separate live voice-call API is not
implemented. Re-auth clears local account data and returns to sign-in. Native APNs
handles new installations while server support for older Expo registrations remains.
Existing legacy-keychain import code is preserved for installed users upgrading to
this native app. Moving the source directory does not change app identity or data.
