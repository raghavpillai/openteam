# OpenTeam for iOS

The native SwiftUI iPhone/iPad client lives in `apps/ios`. The React Native app and
its Expo/Android build have been retired. Native notification- and share-extension
sources, QA fixtures, asset generators, and the Xcode project are all owned here.

Debug installs as **OpenTeam Swift** (`dev.openteam.mobile.swift`) with an isolated
Keychain and `openteam-swift://` links. Release installs as **OpenTeam**
(`dev.openbot.mobile`), retaining the existing TestFlight app, notification and
Keychain identity, and `openteam://` links. Version, build number, bundle ID and
signing team are configured in `release.json`.

## Build and run

Use macOS with Xcode 27+ and Swift 6; the deployment target is iOS 18. Open
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

The script starts fixtures on ports 19997, 19992, 19994, 20070, 20071, 20072, 20081, 20085 and 20093.
It uses ad hoc simulator signing so the discovery tests can exercise Keychain
persistence across cold launches.
`ModelSettingsUITests` uses port 20072 to check provider connection, model and reasoning
saves, failed switches/saves, and persistence after relaunch in light and dark mode.
`Acceptance` covers routines, edge gestures and the local
HTTP/HTTPS installation (fixtures 20032, 20043 and 20039). `MotionPerformance`
covers composer motion and history performance (fixtures 20070 and 19996); run
it after other simulator suites finish. Optional Xcode schemes cover
message motion/performance, widgets, settings, and VNC. See
`Tests/UITests` and `OpenTeamNative.xcodeproj/xcshareddata/xcschemes` for the current
checks; optional live-server tests require their own isolated backend. For an
isolated `FunctionalFlowUITests` rerun, set
`TEST_RUNNER_FUNCTIONAL_FLOW_SERVER=http://127.0.0.1:<fixture-port>` when invoking
`xcodebuild`; the default remains port 19992.
For an isolated `ChatMotionUITests` run, set
`TEST_RUNNER_CHAT_MOTION_SERVER=http://127.0.0.1:<fixture-port>`; the default is 20070.

For keyboard latency investigations, add `--trace-composer-latency` to a DEBUG
chat launch. After a real tap it saves `Documents/composer-latency.json` in the
app container, with touch/editing/keyboard timestamps and display-link samples.
`--composer-latency-control` opens a plain native multiline field for comparison;
tap its title to dismiss the keyboard. These probes are excluded from Release.
Record the simulator concurrently with `idb video --fps 120 --udid <udid> <file>`
and inspect actual frame timestamps and the reported screen refresh limit;
requesting 120 fps does not establish physical-device 120 Hz performance.

The `OpenTeamShare` extension adds OpenTeam to the system share sheet. It reads the
app's saved session from the shared Keychain group and posts directly to the server.
Simulators never show its per-Bot conversation suggestions, because they don't start
`coreduetd`. Run `bash apps/ios/scripts/enable-share-suggestions.sh <simulator-udid>`
after each simulator boot, then send a message so a suggestion is recorded. On a
simulator, tapping a suggestion still opens the sheet without that Bot chosen; the
service that hands the choice to the extension isn't included in simulators.

For scroll smoothness investigations, add `--trace-scroll-frames` to a DEBUG chat
launch. Once scrolling is idle it saves `tmp/scroll-frames.json` in the app
container: each display frame's committed row positions and heights, the finger
location and list state (numeric geometry and message IDs only).
`python3 apps/ios/scripts/scroll-frame-report.py --simulator <udid>` reports layout
shifts, one-frame jumps, finger drift, blank documents and dropped frames. The
fixture's `scroll-mixed` and `scroll-mixed-pages` scenes combine every row
renderer, and `POST /__qa/update-message` edits an existing row in place.

For real transcription, the `RealServer` scheme's
`RealServerUITests/testLiveVoiceTranscriptionAndDraftPreservation` uses
`scripts/real-server-qa.ts`.

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
The v0.0.13 release candidate reserves build 63; source metadata does not establish
a TestFlight upload or availability. Release archives and exports are built locally
with Xcode on macOS. Follow [Releasing OpenTeam](../../.github/RELEASING.md) for
release preparation and publication boundaries; tag pushes do not build releases.
`ci-testflight.sh` is for an ephemeral CI runner, not a developer's personal keychain.
Besides the app and notification profiles, it needs `IOS_SHARE_PROFILE_BASE64`.
Uploading an archive does not establish Apple processing or tester availability.

### In-app update notice

The home-screen Update badge and the notice at the top of Settings open the
OpenTeam public beta in TestFlight, with the HTTPS invitation as a fallback.
The app checks `https://openteam.so/ios-update.json` on launch, on returning to
the foreground (at most once every 15 minutes), and every six hours while active.
It compares both the marketing version and build number, independently of the
self-hosted server. Offline checks retain the last successfully fetched release.

After confirming a build is available to the **public TestFlight group**, update
`apps/landing/public/ios-update.json` and deploy the landing site:

```json
{
  "release": {
    "version": "0.0.11",
    "buildNumber": "62",
    "bundleIdentifier": "dev.openbot.mobile"
  }
}
```

Use the version and build number Apple has made available, not a pending archive.
The initial `{"release": null}` intentionally advertises no unverified builds.
Set it back to null to withdraw a notice. Opening TestFlight keeps the notice
visible until a new app build is installed or the published notice is withdrawn.

For local distribution, archive the Release scheme in Xcode using the configured
team and distribute the archive through Organizer. The app and its
`OpenTeamNotifications` and `OpenTeamShare` extensions each require a matching
provisioning profile. The share extension's App ID is the app's bundle ID plus
`.share`; it needs no capabilities beyond the team's Keychain access group.

## Product boundaries

### Siri, Shortcuts, and Spotlight

App Shortcuts expose **Open a Bot**, **Record a voice note to a Bot**,
**Send a task to a Bot**, **Open a conversation**,
**Run an OpenTeam routine**, and **Find OpenTeam messages** on iOS 18 and later.
For example, say “Send a task with OpenTeam” or “Run a routine in OpenTeam”;
Siri asks for the Bot/routine and any required instructions. Debug builds use the
app name “OpenTeam Swift”. These actions require device authentication and the
saved server session. Task submission returns the accepted message immediately;
the agent continues on the server. Sending, searching, and exporting require a
reachable server over LAN, VPN, or the configured remote address.

To bind a specific Bot to Back Tap or the iPhone Action button:

1. In **Shortcuts**, create a shortcut and add OpenTeam's **Open a Bot** or
   **Record a voice note to a Bot** action. Choose the Bot in its parameter and save.
2. For Back Tap, go to **Settings → Accessibility → Touch → Back Tap**, choose
   **Double Tap** or **Triple Tap**, and select the saved shortcut under **Shortcuts**.
   You can assign one gesture to open the Bot and the other to record to it.
   For the Action button, use **Settings → Action Button → Shortcut** instead.

Choose a fixed Bot when saving each shortcut instead of **Ask Each Time**, and
run it once to grant any required permissions. Both actions require an unlocked,
authenticated device. Back Tap invokes the same saved shortcut; OpenTeam does
not need to be open first. See Apple's [Back Tap setup guide](https://support.apple.com/guide/shortcuts/run-shortcuts-tapping-iphone-apd897693606/ios).

The opening action goes straight to that Bot's chat. The recording action opens
the chat and starts the existing hands-free voice-note flow once the app is
visible, requesting microphone permission if needed. Tap **Send** to transcribe
and send through the existing composer, or discard to keep the draft untouched.
This is voice-note messaging, not a continuous voice call. Transcription must be
configured on the server. Repeating the shortcut preserves an active voice note;
switching Bots during one asks you to send or discard it first. Unused recording
requests expire after 30 seconds and are cleared on account changes, sign-out,
or entering the background. The saved session is checked again immediately
before a visible composer consumes the recording request. Newer shortcut
destinations supersede older context lookups and queued cold-launch requests.
Bot suggestions, name searches, and saved Bot parameters resolve from the
connected account's existing local cache, including the iOS 27 Siri Bot picker.
Known Bots open without waiting for server bootstrap, and a configured voice
composer can start recording once visible. Normal foreground sync refreshes the
directory and transcription configuration independently. Missing or corrupt
caches fall back to a live directory projection that decodes only Bot identity,
name, role, status, and chat membership. Unrelated history or runtime response
fields cannot break the Bot picker. Sending and exporting still validate against
the server. Device unlock, Shortcuts dispatch, app startup, and microphone
permission can still add delay.

The `openteam://chat/<channel-id>` URL scheme (`openteam-swift://` in Debug)
also resumes a link received before the saved account finishes restoring.

On iOS 27, the Messages App Schemas additionally expose drafting and sending
messages through Siri AI. A Bot is a message person, a chat is a conversation,
and replies are message entities. Drafting preserves existing composer text and
attachments. Unsupported scheduling, location, and subject parameters fail
explicitly rather than silently changing what is sent. Recipient lists resolve
only to a unique existing group; intents never create a group implicitly.

**Settings → Siri and Spotlight** opts the connected account into on-device
discovery and visible-message context. The named, protected Spotlight index holds
at most 30 visible conversations, 20 messages per conversation, and 200 messages
in total. Archived bots' conversations, drafts, pending sends, Bot instructions,
and internal metadata are excluded. Index updates remove evicted entries and
update changed content. Disabling discovery, signing out, re-authenticating, or
changing accounts clears donated content. Saved entity identifiers include the
server and account; an old Shortcut cannot resolve into another account.

Message queries can search the server beyond the local index. On iOS 18.4+, view
annotations identify visible messages; on iOS 27 they use the Messages schema.
Text and attachments support content transfer. Attachments are fetched with the
current authenticated session only when requested, and asset membership is
checked against the parent message. Shortcuts actions remain available with
discovery disabled.

Hosted integration tests exercise the actual intents, Keychain, and Spotlight
with synthetic data, including real text/file exports, incremental indexing,
revoked sessions, account changes during requests, and cold-launch navigation.
Start the loopback fixture and upload proxy in separate terminals, then run the
dedicated scheme on an isolated simulator (ad-hoc signing is needed for Keychain
access). The proxy on port 20086 supplies real TCP backpressure for the delivery
progress tests; it forwards to the fixture on port 20084:

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

For manual Shortcuts UI checks, the simulator app additionally needs a code
signature with a TeamIdentifier. Ad-hoc signing permits the hosted tests to use
Keychain, but `linkd` can refuse to find the App Shortcuts provider because the
signature has no team identity. Use a separately signed simulator app for this
check; do not infer a shipping-app registration failure from that simulator error.

#### Integration audit on November 5, 2026

The audit used current `origin/main` at `134d5a42f`, with fixes on
`fix/ios-shortcuts-audit`, rather than the older root checkout. The picker failure
was reproduced with an incompatible bootstrap fixture. The exact response from
the photographed iPhone was not available, so its failing server field is unknown.

- **Bot selection and opening:** fixed both the App Shortcut and iOS 27 Siri
  picker to use the account cache, with a minimal live directory fallback.
  The real iOS 26 Shortcuts app displayed Research, Ops, and Build. Choosing
  Build opened its chat while the fixture server was offline; an uncached
  transcript still requires the server. Saved entity identifiers are unchanged.
- **Voice shortcut:** verified chosen-recipient handoff, cold and warm starts,
  repeated invocations, existing-draft preservation, account changes, permission
  denial, background cancellation, audio interruptions, and recording limits.
  Audio lifecycle tests use synthetic recordings rather than physical microphones.
- **Sending, routines, search, and file transfers:** exercised the production
  intent handlers against synthetic accounts, including actual uploaded/exported
  bytes, accepted message results, routine execution, older-message context,
  invalid recipients, oversized attachment counts, offline errors, and revocation.
- **Siri and Spotlight:** verified the iOS 27 messaging schemas, draft preservation,
  unsupported scheduling rejection, actual Spotlight indexing/editing/removal,
  opt-out, sign-out cleanup, and discovery settings across cold launches.
- **Chat URLs:** fixed queued chat links being lost when restoring an existing
  session. Invalid routes cannot replace the latest queued valid chat link.
- **Share extension:** opened OpenTeam from Safari's actual system share sheet,
  selected Research, sent a URL, and verified exactly one matching message in
  Research's fixture conversation. Per-conversation system suggestions still
  require the separately documented device/coreduet checks.
- **Notifications:** exercised foreground suppression, thread opening, read and
  badge cleanup, foreground reconciliation, registration retry, preferences, and
  retirement. The cold-launch read assertion now waits for transcript positioning
  before checking the actual receipt. Eight notification cases passed across the
  suite and focused reruns; the background-wake case skipped on this simulator.

Validation also passed 200 core tests, 60 iOS 27 system tests, 40 iOS 26 Bot/voice
tests, two discovery UI tests, seven renderer tests, and native signing/transport/extension configuration
checks. Fixture-based tests do not certify production APNs background delivery,
physical Back Tap or Action button gestures, spoken Siri service behavior, real
camera/photo permissions, or physical microphone interruptions. The audit does
not publish an iOS build; installed iPhones need a subsequent release of the fix.

`SystemIntegrationUITests` verifies the discovery setting through the real
signed-in UI, persistence across cold launches, and sending a chat message with
onscreen context enabled. Run a separate fixture on port 20085 and select that
class in the `OpenTeamNative` scheme. Use isolated simulators: these checks save
synthetic sessions in Keychain and clear the app's Spotlight index.

Verify Siri AI language understanding on a supported physical iPhone with Apple
Intelligence enabled. Simulator intent tests do not certify Siri's phrase routing.

Voice recording transcribes into the draft; a separate live voice-call API is not
implemented. Re-auth clears local account data and returns to sign-in. Push
notifications are delivered through APNs only. Moving the source directory does not
change app identity or data.
