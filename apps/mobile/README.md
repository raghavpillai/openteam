# OpenBot for iPhone

This is the research-backed iOS companion shell described in `plans/34-ios-mobile-parity.md`.

It is fixture-backed by default so visual work can proceed without exposing a server. Configure a
random `OPENBOT_API_TOKEN` on the server, then open **Settings → Private connection** on the iPhone
and save the reachable server URL and matching token. The token is stored in the device Keychain.

For a local development build, the URL can also be bundled as a starting value:

```sh
EXPO_PUBLIC_OPENBOT_API_URL=http://<trusted-openbot-host>:4040 bun --cwd apps/mobile dev
```

Native push notifications also require an Expo/EAS project ID so Expo can attribute the APNs
token. Set `EXPO_PUBLIC_EXPO_PROJECT_ID`, open the in-app Settings screen, and tap **Enable**. The
app requests iOS authorization in context, stores an installation identifier in Keychain, and
registers the Expo push token with the OpenBot server. The worker sends native alerts for direct
Bot chats only; group and hidden-Bot activity is intentionally silent.

Release builds still need the normal Apple Push Notifications capability, a provisioning profile,
and push credentials configured for the Expo/EAS project. Push is tested in a development build,
not Expo Go.

`eas.json` includes development, internal-preview, and production profiles. Once an Expo project
and Apple team are linked, use `eas build --platform ios --profile development` for device testing
and `eas build --platform ios --profile production` for an App Store archive. Keep
`EXPO_ACCESS_TOKEN` on the worker when enhanced Expo push security is enabled.

Non-loopback API access is rejected unless `OPENBOT_API_TOKEN` is configured and sent as a Bearer
credential. Loopback remains trusted for the desktop app; set `OPENBOT_API_TRUST_LOOPBACK=false`
when a reverse proxy terminates untrusted traffic on localhost. Content-addressed asset downloads
remain unlisted capability URLs so native image and file viewers can open them. Use HTTPS before
shipping outside a private network.

## Current slice

- iPhone-only Expo/React Native shell with the New Architecture enabled;
- current snapshot, home roster, conversation, optimistic send, replies, reactions, approvals, working state, local search, notification settings, and push deep links;
- native SF Symbols, safe areas, keyboard avoidance, haptic interaction, spring reply/reaction motion, light/dark tokens;
- portable `@openbot/client-core` transport and snapshot selectors shared with future clients.

## Native validation

Validated locally on 2026-08-28 with Xcode 26.6, the iOS 26.5 runtime, and an iPhone 17 Pro simulator. This is an Expo development build compiled by Xcode, not Expo Go:

```sh
bun --cwd apps/mobile ios
```

The first native build is intentionally slower because CocoaPods, React Native codegen, Hermes, Reanimated, and Worklets are compiled from source. Later JS/TS changes use Metro fast refresh. Captured validation screens and the interaction record live in `apps/mobile/artifacts/`.

`expo-doctor` currently reports two monorepo-development warnings: Bun's isolated workspace links appear as duplicate same-version Expo packages, and checked-in/generated `ios/` means app-config changes require a fresh `expo prebuild`. The actual native dependency graph was built successfully with Expo 57's supported Reanimated `4.5.1` and Worklets `0.10.1` pair.
