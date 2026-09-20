# Desktop and native iOS VNC migration — September 20, 2026

Both interactive computer viewers now use authenticated VNC through the OpenTeam server. Desktop no longer falls back to an iframe or HTTP input. Native iOS no longer uses MJPEG, polling images, or HTTP pointer/keyboard actions. A server without the VNC endpoint displays an update requirement.

This supersedes the implementation status in the earlier `findings/vnc-network-2026-09-20/README.md` audit.

## Implementation

- Desktop uses the bundled, lazily loaded noVNC 1.7.0 client. It connects to the selected server, including a Tailscale IP or HTTPS hostname, and retains the last frame during reconnects.
- Native iOS embeds the same noVNC version in a private, nonpersistent WKWebView. Native touch, keyboard, clipboard, pause, control ownership, and zoom controls remain native. The owner bearer token stays in Swift; only the one-use VNC grant enters the bundled document.
- Native pointer movement, button down/up, scrolling, text, and special keys are sent through RFB. Drag input now streams intermediate pointer movements. Two physical taps no longer replay an extra double-click sequence.
- Both clients validate the grant's exact bot-specific socket path and preserve server path prefixes. HTTPS selects WSS. No credentials appear in the WebSocket URL.
- The server proxy uses short-lived, single-use grants bound to the authenticated session, bot, and origin. It checks session revocation and restricts the upstream to the configured computer service.
- Native iOS disables input while disconnected, paused, or changing ownership. Done and backgrounding release control. Lease renewal no longer temporarily disables input every 20 seconds.
- HTTP remains for status, control ownership, and explicit managed application launch. Desktop's closed preview still uses a snapshot. These are not interactive viewer fallbacks; server snapshot/action endpoints remain for those operations and other consumers.

Native bundled assets are generated with `bun apps/mobile-swift/scripts/export-computer-vnc.ts`. The generated HTML and third-party license notices are checked into the app resources so an Xcode build does not need a network download.

## Live verification

Tests used the deployed server image with a disposable owner/database and a dedicated Linux desktop. Main-account credentials were untouched. No certificate checks were bypassed.

| Check | Desktop | Native iOS simulator |
| --- | --- | --- |
| Tailscale IP, HTTP/WS | Live screen, click, typing passed | Live screen, keyboard and clipboard input passed |
| Tailscale hostname, HTTPS/WSS | Live screen, click, typing passed | Live screen, native touch, keyboard and clipboard input passed |
| Forced server stop/start | Automatically reconnected | Automatically reconnected; retained frame and disabled input while offline |
| Pause/resume | Existing viewer lifecycle retained | Retained frame and reconnected successfully |
| Control release | Desktop's existing handoff behavior retained | Done and backgrounding verified against server state |
| Final build smoke test | Fresh production-component bundle connected and typed over WSS | Final signed simulator app connected and typed over WSS; Done released control |

Desktop live tests mounted the actual production VncComputer component in Electron's file context. iOS tests used the normal native sign-in and Computer UI in an iPhone 17 Pro simulator running iOS 26.5. Remote test text was not submitted as a shell command.

The authenticated disposable endpoints were `http://100.94.42.50:18787` and `https://office-mac-mini.tail658346.ts.net:10001`. Both originated from this Mac. This validates address selection and TLS/WebSocket compatibility, not off-host WAN latency.

## Automated checks and builds

- Server VNC tests: **8 passed**, 22 assertions.
- Desktop URL and control tests: **10 passed**, 36 assertions.
- Swift core tests: **87 passed**, including malformed grants, route binding, HTTPS, path prefixes, and credential-free socket URLs.
- Desktop computer-view regression: full-window geometry in both themes; unsupported-server message in both themes with zero iframe fallback and zero HTTP input; 11 snapshot-resource lifecycle checks passed.
- Desktop type check and production build passed.
- Native iOS app and UI-test target built successfully. The updated optional VNC XCTest suite was compiled, not executed; live interaction checks in this pass used computer automation.
- macOS package built, strict code-signature verification passed, and local notification identity passed.
- The QA WebSocket proxy bundles successfully. Its optional XCTest fault-injection workflow was not executed in this pass.
- Whitespace checks passed for source changes. Bundled third-party notices preserve four upstream trailing spaces across the original and combined copies.

The desktop performance budget still fails for a pre-existing Electron runtime size overage: **2,453,054 bytes versus 2,320,000 allowed**. The installed build before VNC was already 2,451,555 bytes. The Electron runtime budget was not relaxed. Renderer budgets account for the added noVNC dependency, with a separate lazy-load limit. Other reported build checks passed.

## Builds and remaining coverage

The local desktop app at `apps/desktop/release-local/mac-arm64/openteam.app` was updated. Its previous version is preserved alongside it as `openteam.pre-vnc-only-20260920.app`.

Transfer build: `output/research/vnc-migration-2026-09-20/OpenTeam-VNC-mac-arm64.zip` (119 MB, Apple Silicon, locally signed).

Native simulator build: `apps/mobile-swift/.build-vnc-migration/Build/Products/Debug-iphonesimulator/OpenTeamNative.app`.

The other computer still needs the new desktop build. No physical iPhone, TestFlight deployment, off-host latency benchmark, or physical continuous drag/pinch/multitouch validation was completed. Those are remaining release/device checks; the simulator result is not a claim of full physical-device coverage.

## Cleanup and evidence

The disposable computer was destroyed successfully. The temporary server container, QA database, and HTTPS port 10001 were removed. The QA simulator was shut down. Existing Tailscale services remained in place and the main server on port 8787 returned HTTP 200 afterward.

Logs, the simulator screenshot, cleanup results, and the desktop transfer build are in `output/research/vnc-migration-2026-09-20/`. Test credentials belonged only to the removed disposable account. No main-owner credential was stored in the report or test output.
