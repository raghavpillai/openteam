# Robot launch

Launch now shows only our orange chip robot with the existing thinking animation and a soft ground shadow. The background is pure black in dark mode and pure white in light mode. Status text, spinner, status bar and app controls stay hidden until the launch cover fades away.

[Watch the native preview](../../../output/swift-launch-robot-0916/preview.html).

`LaunchContentView` starts the existing store and pending notification route underneath the cover. Fast startup has a 700 ms minimum display; slower startup adds no further hold. The cover fades over 400 ms, then releases interaction and notification permission prompts. The animation state lives in the view so it participates in SwiftUI's animation transaction. Reduce Motion uses the existing still robot rendering and a shorter 150 ms opacity transition.

The loader appears on launch, not on foreground return or reconnect. An unsuccessful startup reveals the existing connection flow. Existing authenticated sessions, cached messages and notification routes continue through their established store paths.

Validation artifacts are in `output/swift-launch-robot-0916/`:

- `LaunchRobot-Acceptance.xcresult`: three passing cases covering dark/light startup, working composer afterward, retained drafts and no replay on foreground, plus startup failure recovery.
- `Notification-Acceptance.xcresult`: notification tap cold-launches the correct conversation and acknowledges its read state. This uses real simulator notification delivery with an inert server; it does not validate physical APNs delivery.
- `Message-Acceptance.xcresult`: message sending and lost-acknowledgment reconciliation after launch.
- `robot-core.log`: five passing robot motion tests, including Reduce Motion and interruption behavior. The existing native Reduce Motion/backgrounding test also passes in `Regressions.xcresult`.
- `visual-acceptance.json`: original capture hashes, exact black/white backgrounds and changed pixels confined to the animated robot. `fade-acceptance.json` records multiple intermediate frames through the approximately 400 ms fade, verified against the native video.

The optional `LaunchRobot` scheme uses the isolated in-memory parity fixture on port 20028. Start it with `SWIFT_PARITY_PORT=20028 bun apps/mobile-swift/scripts/parity-server.ts`; the scheme is excluded from the default suite. The preview contains original screenshots and a trimmed screen recording, without fabricated product frames.
