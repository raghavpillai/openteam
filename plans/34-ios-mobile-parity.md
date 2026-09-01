# iOS release and device parity: remaining work

Status: React Native feature flows and Release-simulator matrix shipped; physical-device and public
distribution acceptance remain open
Last audited: 2026-09-01

## Production distribution

- Configure the real Expo/EAS and Apple team, bundle/build/version policy, signing identities,
  provisioning, Keychain groups, APNs credentials, privacy manifests, dSYM upload, and store
  metadata.
- Produce and inspect a clean signed archive and exported IPA: entitlements, APNs environment,
  architectures, thinning report, dependency embedding, symbols, receipt behavior, and final size.
- Require HTTPS, restricted origins, rate limits, device/session controls, and a short-lived,
  least-privilege shared-computer viewer authorization before the app targets a public server.
- Prove APNs registration, delivery, notification actions, stale-approval reconciliation, deep
  links, background notifications, sign-out, and token revocation on production credentials.

## Physical-device acceptance

Run the existing critical-flow and large-fixture matrix on representative iPhones and record:

- cold/warm launch, input-to-paint, JS/UI FPS, hitches, main-thread stalls, RSS/heap, memory-warning
  recovery, background energy, radio usage, and thermals;
- Wi-Fi/LAN permission, cellular/offline transitions, interruption recovery, foreground/background
  execution, uploads, and computer takeover/release;
- camera, Photo Library, HEIC/iCloud selection, microphone levels/transcription, haptics, Keychain,
  share/download handoff, six 25 MiB uploads, and one maximum-size video;
- VoiceOver traversal/actions, Dynamic Type at accessibility sizes, Reduce Motion/Transparency,
  increased contrast, target sizing, Switch Control, and hardware-keyboard focus;
- current Grok Bot reference captures for any remaining claim of exact style, gesture, haptic, or
  animation parity. Marketing composites are not point-level evidence.

## Remaining product and automation work

- Add upload progress, cancellation, retry, background recovery, and bounded native-memory tests.
- Replace roster-proportional fallback bootstraps with bounded deltas or pagination at large bot
  counts if the current event/fallback path still exceeds the accepted network budget.
- Add revision/ETag or event-driven computer frames so an unchanged screen does not decode a new
  image every polling cycle.
- Add a maintained XCTest/XCUITest target that covers the native release smoke and highest-risk
  interaction paths in CI.
- Resolve archive-time Expo native-layout/autolinking ambiguity and keep native synchronization as
  an explicit review gate for configuration changes.
- Decide separately whether tables, rendered math/Mermaid, or larger document previews justify
  native renderers; keep current selectable-source/file-handoff fallbacks until they pass memory
  and accessibility budgets.

## Release gate

Do not call the app fully accepted on iOS or ready for App Store distribution until the production
archive, APNs, public-network security, physical-device performance/lifecycle/media matrix, full
accessibility pass, and current-reference visual/motion comparison all pass. Simulator evidence
alone cannot close these items.

## Current code and retained evidence

- `apps/mobile/`
- `apps/mobile/README.md`
- [`evidence/openbot-ios/`](./evidence/openbot-ios/)
- [`evidence/openbot-ios-audit-2026-08-31/`](./evidence/openbot-ios-audit-2026-08-31/)
- [`evidence/openbot-ios-simulator-2026-09-01/`](./evidence/openbot-ios-simulator-2026-09-01/)
