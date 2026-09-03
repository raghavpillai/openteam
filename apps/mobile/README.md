# OpenTeam for iOS and Android

This is the Expo/React Native mobile companion. The iOS native project is checked in under `ios/`;
Android uses the same application and login flow.

It is fixture-backed by default so visual work can proceed without exposing a server. Configure a
reachable server endpoint on the login screen, then sign in with the same owner username/password
created by `openteam setup`. The resulting session is stored in platform secure storage; no separate
API token is required. Use **Settings → Private connection** to change the server URL or sign out.

For a local development build, the URL can also be bundled as a starting value:

```sh
EXPO_PUBLIC_OPENTEAM_API_URL=http://<trusted-openteam-host>:4040 bun --cwd apps/mobile dev
```

Native push notifications also require an Expo/EAS project ID so Expo can attribute the APNs
token. Set `EXPO_PUBLIC_EXPO_PROJECT_ID`, open the in-app Settings screen, and tap **Enable**. The
app requests iOS authorization in context, stores an installation identifier in Keychain, and
registers the Expo push token with the OpenTeam server. The worker sends native alerts for direct
Bot chats only; group and hidden-Bot activity is intentionally silent.

Release builds still need the normal Apple Push Notifications capability, a provisioning profile,
and push credentials configured for the Expo/EAS project. Push is tested in a development build,
not Expo Go.

`eas.json` includes development, internal-preview, and production profiles. Once an Expo project
and Apple team are linked, use `eas build --platform ios --profile development` for device testing
and `eas build --platform ios --profile production` for an App Store archive. Keep
`EXPO_ACCESS_TOKEN` on the worker when enhanced Expo push security is enabled.

The server defaults to `OPENTEAM_AUTH_MODE=required`, so the mobile app uses its username/password
session for every product API request. `OPENTEAM_AUTH_MODE=disabled` deliberately removes product
API authentication and is suitable only for a fully trusted, isolated network; never expose that
mode to the internet or an untrusted LAN. Content-addressed asset downloads remain unlisted
capability URLs so native image and file viewers can open them. Use HTTPS outside the host machine.

## Current slice

- shared iOS and Android Expo/React Native shell with the New Architecture enabled;
- authenticated home roster with synced pins, hide/unhide, Bot duplication, Bot/group creation and profile editing, and confirmed Bot deletion;
- bounded bootstrap and per-conversation history pagination, foreground reconciliation, an offline last-known snapshot, and persisted per-conversation text/attachment/reply drafts;
- optimistic send, replies, reactions, group mention suggestions, file/photo/camera attachments, approvals, working state, server search, and exact-message deep links;
- shared-computer watch/takeover, read-only routine details with pause/resume, notification settings, push deep links, sign-out, and persistent System/Light/Dark appearance;
- native SF Symbols, safe areas, keyboard avoidance, haptic interaction, spring reply/reaction motion, light/dark tokens;
- portable `@openteam/client-core` transport and snapshot selectors shared with future clients.

## Native validation

The checked-in native project was validated on 2026-08-28 with Xcode 26.6, the iOS 26.5 runtime, and an iPhone 17 Pro simulator. This is an Expo development build compiled by Xcode, not Expo Go:

```sh
bun --cwd apps/mobile ios
# or
bun --cwd apps/mobile android
```

The first native build is intentionally slower because CocoaPods, React Native codegen, Hermes, Reanimated, and Worklets are compiled from source. Later JS/TS changes use Metro fast refresh.

`expo-doctor` currently reports two monorepo-development warnings: Bun's isolated workspace links appear as duplicate same-version Expo packages, and checked-in/generated `ios/` means app-config changes require a fresh `expo prebuild`. The actual native dependency graph was built successfully with Expo 57's supported Reanimated `4.5.1` and Worklets `0.10.1` pair.

The checked-in APNs entitlement deliberately remains `development`: Expo's notifications plugin
generates that source value and Xcode replaces it from the distribution provisioning profile when
it creates a release archive. Expo Updates is also deliberately disabled; releases are App Store
binary releases until an update channel and runtime-version policy are explicitly adopted.

Before distributing any production EAS archive, unzip the IPA and inspect the signed product rather
than treating the source plist as release evidence:

```sh
codesign -d --entitlements :- Payload/OpenTeam.app
plutil -p Payload/OpenTeam.app/Info.plist
```

The signed entitlements must contain `aps-environment = production`; the built Info.plist must carry
the intended marketing version and the remotely managed, monotonically increasing build number.
The mobile test suite separately gates checked-in app/native config parity and verifies that Expo's
Apple autolinker resolves each package and pod exactly once under Bun's isolated workspace layout.

`eas.json` provides both physical-device and simulator development profiles. Push delivery still needs a real Expo project ID, Apple signing team, APNs credentials, and a signed physical-device validation pass; the simulator cannot validate APNs, camera, microphone/dictation, or physical haptics.
