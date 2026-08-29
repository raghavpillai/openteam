# OpenBot for iPhone

This is the research-backed iOS companion shell described in `plans/34-ios-mobile-parity.md`.

It is fixture-backed by default so visual work can proceed without exposing a server. To connect a development iPhone over a trusted network or Tailscale, set:

```sh
EXPO_PUBLIC_OPENBOT_API_URL=http://<trusted-openbot-host>:4040 bun --cwd apps/mobile dev
```

The current OpenBot v0 API is unauthenticated. Do not expose it to an untrusted network or ship a public build against it. Public distribution is blocked on HTTPS, user/device authentication, and scoped viewer authorization.

## Current slice

- iPhone-only Expo/React Native shell with the New Architecture enabled;
- current snapshot, home roster, conversation, optimistic send, replies, reactions, approvals, working state, and local search;
- native SF Symbols, safe areas, keyboard avoidance, haptic interaction, spring reply/reaction motion, light/dark tokens;
- portable `@openbot/client-core` transport and snapshot selectors shared with future clients.

## Native validation

Validated locally on 2026-08-28 with Xcode 26.6, the iOS 26.5 runtime, and an iPhone 17 Pro simulator. This is an Expo development build compiled by Xcode, not Expo Go:

```sh
bun --cwd apps/mobile ios
```

The first native build is intentionally slower because CocoaPods, React Native codegen, Hermes, Reanimated, and Worklets are compiled from source. Later JS/TS changes use Metro fast refresh. Captured validation screens and the interaction record live in `apps/mobile/artifacts/`.

`expo-doctor` currently reports two monorepo-development warnings: Bun's isolated workspace links appear as duplicate same-version Expo packages, and checked-in/generated `ios/` means app-config changes require a fresh `expo prebuild`. The actual native dependency graph was built successfully with Expo 57's supported Reanimated `4.5.1` and Worklets `0.10.1` pair.
