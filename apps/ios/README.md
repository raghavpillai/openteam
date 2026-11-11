# OpenTeam for iOS

The native SwiftUI iPhone/iPad client lives in `apps/ios`, together with its
notification and share extensions, QA fixtures, asset generators and the Xcode project.

Debug installs as **OpenTeam Swift** (`dev.openteam.mobile.swift`) with an isolated
Keychain and `openteam-swift://` links. Release installs as **OpenTeam**
(`dev.openbot.mobile`), the TestFlight app's identity, with `openteam://` links.
Version, build number, bundle ID and signing team are configured in `release.json`.

## Build and run

For Siri AI preview development, use macOS with Xcode 27.3 beta or later and Swift 6.
The deployment target is iOS 18. See App Store builds below for stable-toolchain
archive instructions. Open
`OpenTeamNative.xcodeproj`, select the `OpenTeamNative` scheme and an iOS simulator,
and Run. Connect to your OpenTeam server using its reachable HTTP or HTTPS address.
The native target has no Expo, React Native or CocoaPods runtime dependency. Its only
packages are `ThinkingOrbsKit` and `VoiceGlowKit` from
[Libraries.dev](https://github.com/Jakubantalik/Libraries.dev) (MIT), pinned to one
revision in `scripts/generate-project.py`. VoiceGlowKit compiles a Metal shader, so
install Xcode's Metal toolchain once: `xcodebuild -downloadComponent MetalToolchain`.

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
viewer. For a version/build-only release change, run just
`python3 apps/ios/scripts/generate-project.py` and verify that the diff contains only
the intended metadata; preserve the committed renderer and viewer bytes. Its
JavaScript dependencies are pinned in this workspace's `package.json`.
Ordinary messages, chat navigation, composer and state are native Swift views.

## Siri AI preview and app skills

Build with Xcode 27.3 beta or later and explicitly enable the preview SDK features:

```sh
xcodebuild -project apps/ios/OpenTeamNative.xcodeproj -scheme OpenTeamNative \
  -destination 'generic/platform=iOS Simulator' \
  'SWIFT_ACTIVE_COMPILATION_CONDITIONS=$(inherited) OPENTEAM_SIRI_AI_PREVIEW' \
  EXCLUDED_SOURCE_FILE_NAMES= build
```

App Shortcuts support iOS 18 and later, and
saved Shortcuts (such as a Bot assigned to Back Tap) are keyed to the existing intent
identifiers. Custom Siri tools need iOS 27.3 and the Messages domain schemas need
iOS 27; their `ToolIntent` conformances are availability-scoped extensions, so older
saved actions keep working.

`Resources/Skills.skillsbundle` contains three Apple app skills: delegate a task,
review a conversation, and run an existing routine once. Xcode compiles them to
`Metadata.appintents/Skills.skillsc`. They are instructions for Siri's reasoning,
not executable workflows. Check the compiled output with:

```sh
python3 apps/ios/scripts/check-siri-skills.py <path-to-OpenTeamNative.app>
```

Siri's live reasoning and app-skill selection can only be tested on an Apple
Intelligence-capable device on iOS 27.3 with preview access, running a
development-signed app or an internal TestFlight build. External TestFlight and App
Store builds don't enable preview testing, and the Simulator verifies actions and
indexing only. See Apple's [preview requirements](https://developer.apple.com/documentation/appintents/siri-ai-developer-preview)
and [app skills guide](https://developer.apple.com/documentation/appintents/orchestrating-complex-actions-with-app-skills).

The opt-in `SiriSkills` scheme runs device-only `SiriEvaluations` tests for server
search, named-group drafting and a conversational follow-up. Use an isolated QA
account with a group named `Release review`, and set `OPENTEAM_LIVE_SIRI_TESTS=1` and
`OPENTEAM_SIRI_QA_CONVERSATION_ID` (the group's `TeamConversationEntity` ID, not the
raw server channel ID) in the test runner's environment. Without them the tests skip.
The tests open drafts, so clear them between runs.

## Shortcuts and Spotlight

App Shortcuts (`Sources/App/TeamIntents.swift`) expose **Open a Bot**, **Record a
voice note to a Bot**, **Send a task to a Bot**, **Open a conversation**, **Run an
OpenTeam routine** and **Find OpenTeam messages**. They need device authentication
and the saved server session; sending, searching and exporting also need a reachable
server. Send and run actions return once the server accepts the work, not when the
Bot answers. Users bind saved shortcuts to Back Tap or the Action button as described
in [Desktop and mobile](../../docs/getting-started/apps.md).

Bot pickers, name searches and saved Bot parameters resolve from the account's local
cache, so known Bots open without waiting for the server; a missing or corrupt cache
falls back to a minimal live directory. The recording action opens the Bot's chat and
starts the normal voice-note flow. `openteam://chat/<channel-id>`
(`openteam-swift://` in Debug) opens a chat, including a link received before the
saved account finishes restoring.

On iOS 27 the Messages App Schemas add drafting and sending through Siri: a Bot is a
message person, a chat is a conversation, and replies are message entities. Drafting
keeps existing composer text and attachments, and unsupported scheduling, location
and subject parameters fail explicitly. Named groups use explicit conversation
send/draft tools because the 27.3 SDK rejects conversation destinations in the
Messages schema. Recipient lists resolve only to a unique existing group; intents
never create one.

The **Siri and Spotlight** switch in Settings gates on-screen message annotations and
the on-device index (`Sources/App/SystemDiscovery.swift`). The protected index holds
at most 30 conversations, 20 messages per conversation and 200 messages in total, and
excludes archived Bots' conversations, drafts, pending sends and Bot instructions.
Turning the switch off, signing out, re-authenticating or changing accounts clears
donated content. Entity IDs include the server and account, so an old Shortcut can't
resolve into another account. Message queries can search the server beyond the
index, and attachments are fetched with the current session only when requested.
Shortcuts actions work with the switch off.

## QA

The loopback parity server uses synthetic accounts and content, never a model or
connected service. Start it with:

```sh
bun apps/ios/scripts/parity-server.ts
```

The default port is 19997; override it with `SWIFT_PARITY_PORT`. The DEBUG-only
launch arguments `--ui-testing --server http://127.0.0.1:19997` use temporary QA
storage and do not persist a real login in Keychain.

Run the core, client-contract and default native UI checks against a booted simulator.
The script needs `bun`, `curl` and ripgrep (`rg`):

```sh
bash apps/ios/scripts/verify.sh <simulator-udid> [result-dir]
```

It starts fixtures on ports 19997, 19992, 19994, 20070, 20071, 20072, 20081, 20085,
20093, 20137 and 20171 (reusing any already running) and writes logs and the result
bundle to `output/swift-native-<timestamp>/` unless you pass a result directory. It
uses ad hoc simulator signing so the discovery tests can exercise Keychain persistence
across cold launches.

Other schemes in `OpenTeamNative.xcodeproj/xcshareddata/xcschemes` run separately;
see `Tests/UITests` for the current checks:

- `Acceptance` runs `RoutineScheduleUITests` (fixture on port 20032),
  `EdgeBackUITests` (port 20043, or set `EDGE_BACK_SERVER`) and `LiveHTTPUITests`.
  `LiveHTTPUITests` (also its own `LiveHTTP` scheme) checks discovery and sign-in
  against a real installation over HTTP and HTTPS. Its two server addresses are
  hard-coded in `Tests/UITests/LiveHTTPUITests.swift`; replace them with your own
  server's before running it.
- `MotionPerformance` covers composer motion and history performance (fixtures 20070
  and 19996). Run it after other simulator suites finish.
- `SearchNavigation` checks search, result highlighting and history paging against a
  fixture started with `SWIFT_PARITY_PORT=20124`.
- `RealServer` includes `testLiveVoiceTranscriptionThroughMicrophone`, which uses
  `scripts/real-server-qa.ts`. Other optional schemes cover message motion and
  performance, widgets, settings and VNC; live-server tests need their own isolated
  backend.

Some suites read their fixture address from an environment variable. Pass it to
`xcodebuild` with a `TEST_RUNNER_` prefix, for example
`TEST_RUNNER_FUNCTIONAL_FLOW_SERVER=http://127.0.0.1:<fixture-port>` (default 19992)
or `TEST_RUNNER_CHAT_MOTION_SERVER=…` (default 20070).

The `SystemIntents` scheme runs hosted tests of the real intents, Keychain and
Spotlight with synthetic data. Start the fixture and the upload proxy (port 20086,
which forwards to the fixture on 20084 and supplies real TCP backpressure) in
separate terminals, then run the scheme on an isolated simulator:

```sh
# Terminal 1
SWIFT_PARITY_PORT=20084 bun apps/ios/scripts/parity-server.ts
# Terminal 2
node apps/ios/scripts/send-upload-proxy.cjs
# Terminal 3
xcodebuild -project apps/ios/OpenTeamNative.xcodeproj -scheme SystemIntents \
  -destination 'platform=iOS Simulator,id=<simulator-udid>' \
  -parallel-testing-enabled NO CODE_SIGN_IDENTITY=- test
```

`SystemIntegrationUITests` (part of the `OpenTeamNative` scheme, fixture on port
20085) checks the **Siri and Spotlight** switch through the signed-in UI. Use
isolated simulators for these suites: they save synthetic sessions in Keychain and
clear the app's Spotlight index. Manual Shortcuts UI checks need a simulator build
signed with a team; with ad hoc signing, `linkd` may not find the App Shortcuts
provider. On the iOS 27.1 Duo simulator the app can stay in the foreground after
Home, so the voice background check skips there.

Simulators don't show the share sheet's per-Bot suggestions until you run
`bash apps/ios/scripts/enable-share-suggestions.sh <simulator-udid>` after each boot
and then send a message.

Two DEBUG-only probes help with performance work. `--trace-composer-latency` saves
`Documents/composer-latency.json` after a real tap (`--composer-latency-control`
opens a plain native field for comparison). `--trace-scroll-frames` saves
`tmp/scroll-frames.json` once scrolling is idle; report on it with
`python3 apps/ios/scripts/scroll-frame-report.py --simulator <udid>`.

```sh
bun run ios:performance
```

This runs Release Swift history benchmarks. Simulator tests don't certify physical
haptic feel, production APNs delivery, microphone or camera interruptions, iPhone
frame rate, or Siri's spoken phrase routing.

## App Store builds

Use a stable Xcode toolchain accepted by App Store Connect for public releases.
The standard iOS 18+ Shortcuts integration remains enabled.
Stable builds omit the preview-only `Skills.skillsbundle` resource and custom
`ToolIntent` conformances by default. A compiler version check is insufficient:
Xcode 27.2 ships Swift 6.4.2 without the preview's `ToolIntent` API. For internal
Siri preview builds, use Xcode 27.3 beta and the explicit opt-in command above.

Public App Store builds use the App Store for updates. The in-app TestFlight
update notice is enabled for sandbox-receipt beta builds and Debug QA builds.
The privacy policy is available before sign-in and in Settings.

## Release

The upload checklist, including how to choose the build number, is in
[`.github/RELEASING.md`](../../.github/RELEASING.md). Keep `release.json`'s version
in sync with this workspace's `package.json`, and regenerate the project after
changing it.

The v0.0.16 App Store submission uses build 67, archived with stable Xcode 27.1
and submitted for review on November 10, 2026. Recheck both builds and build uploads
before choosing another build number.

### In-app update notice

In TestFlight and Debug builds, the home-screen Update badge and the notice at
the top of Settings open the OpenTeam public beta in TestFlight, with the HTTPS
invitation as a fallback.
The app checks `https://openteam.so/ios-update.json` on launch, on returning to
the foreground (at most once every 15 minutes), and every six hours while active.
It compares both the marketing version and build number, independently of the
self-hosted server. Offline checks retain the last successfully fetched release.

After confirming a build is available to the **public TestFlight group**, update
`apps/landing/public/ios-update.json` and deploy the landing site:

```json
{
  "release": {
    "version": "0.0.12",
    "buildNumber": "62",
    "bundleIdentifier": "dev.openbot.mobile"
  }
}
```

Use the version and build number Apple has made available, not a pending archive.
`{"release": null}` advertises no build; set it back to null to withdraw a notice.
Opening TestFlight keeps the notice visible until a new app build is installed or
the published notice is withdrawn.

### Sign with your own team

The Release configuration takes its bundle ID and `DEVELOPMENT_TEAM` from
`release.json`, so set `teamIdentifier` to your Apple Developer team and
`bundleIdentifier` to an App ID your team owns, then run
`python3 apps/ios/scripts/generate-project.py`. There is no separate Release scheme:
archiving the `OpenTeamNative` scheme uses the Release configuration. Distribute the
archive through Organizer.

The app and its `OpenTeamNotifications` and `OpenTeamShare` extensions each need a
matching provisioning profile; their App IDs are the bundle ID, plus
`.notifications` and `.share`. To pin profiles, set the `APP_PROVISIONING_PROFILE`,
`EXTENSION_PROVISIONING_PROFILE` and `SHARE_PROVISIONING_PROFILE` build settings. The
share extension needs no capabilities beyond the team's Keychain access group.

## Product boundaries

Voice notes are transcribed, added to any draft text and sent; there is no live
voice call. Re-auth clears local account data and returns to sign-in. Push
notifications are delivered through APNs only. Moving the source directory does not
change app identity or data.
