# Native remote desktop / VNC validation — September 16, 2026

**Later fixes:** [Swift backlog fixes and validation](BACKLOG-FIXES-0917.md) supersede the delivery, plugin access/OAuth, approvals, thread/search and computer-gesture findings described below. Historical captures remain unchanged.

**The desktop is functional, but the native viewer is not ready for sign-off.** The live backend accepts real input, and the underlying VNC connection works. Native gesture gaps and visual differences remain. This was an audit: no application gesture or viewer implementation was changed.

[Three reference comparisons and evidence](../../../output/swift-vnc-qa-0916/review.html).

## What is actually being tested

The native Swift screen uses authenticated `/screen`, `/screen/frame`, `/screen/actions` and `/screen/takeover` APIs. It fetches PNG screenshots; it does **not** use the VNC/RFB stream. Its loop waits one second between refreshes and skips refreshes while input is pending. The measured frame completion intervals were approximately **1.06–1.19 seconds** on this local setup.

The computer also runs x11vnc and noVNC. Those were tested separately using the current `docker/openteam-vnc.html`. Calling the native screen “VNC” should not imply that Swift currently has a streaming VNC client.

The test used an isolated authenticated server, PostgreSQL, worker and current computer gateway on ports 20020–20025, with a disposable Linux desktop. The Swift app ran on an iPhone 16 Pro Max simulator, iOS 26.5. A browser page on that desktop recorded trusted keyboard and pointer events. The page is synthetic; the browser, X11 desktop, server routes, authentication, screenshots and control leases are real. Explicitly injected network/HTTP failures are marked in the receipts. No production conversations or account credentials were changed.

## Confirmed problems

| Finding | Evidence | Impact |
| --- | --- | --- |
| **QA-12: Trackpad movement never reaches the computer.** | Dragging visibly moves the local dot. The actual browser recorded **0 pointer moves**, and no `/actions` request was sent. `testTrackpadMovesTheRemotePointer` fails. | Hover and pointer positioning on the remote desktop do not work while moving the trackpad. The handler returns after updating the local pointer; it also cannot emit a remote trackpad drag. |
| **QA-12: Two-finger right-click is missing.** | A real XCTest two-finger tap recorded **0 right-clicks** and sent no action. `testTwoFingerTapRightClick` fails. | The corresponding gesture from the old client is absent. |
| **QA-12: Two-finger scrolling is missing.** | Code inspection: the only two-finger pan belongs to the local `UIScrollView`; no handler emits a remote scroll action. This is not a claim of a physical two-finger drag test. The real backend's explicit scroll API did move the page. | At normal zoom the gesture cannot scroll the remote page, despite the Help text saying it can. At higher zoom it pans the local viewport. |
| **QA-18: Rapid tap/double-tap/hold can become left-clicks.** | The sequence sent **two double-left-click actions**, producing **4 left-clicks and 0 right-clicks**. The same target received five correct holds when tested from idle with each receipt awaited. | Right-click remains unreliable around a rapid preceding tap sequence. The erroneous actions originate in the native recognizers, before the backend. This audit does not claim the timing cause is fully isolated. |
| **Native refresh is visibly limited.** | Source waits one second per polling loop; live completion intervals were 1.06–1.19 seconds. Frames are not refreshed while pending input keeps `working` true. | This is a screenshot viewer, with substantially less immediate visual feedback than a streaming desktop. |
| **Reference layout is not one-to-one.** | Measurements below and original side-by-side captures. | Desktop placement, loading placement and bottom-control sizing/position need further adjustment. |

Relevant implementation: [ComputerSurface.swift](../Sources/App/ComputerSurface.swift), [ComputerView.swift](../Sources/App/ComputerView.swift), [ComputerKeyboard.swift](../Sources/App/ComputerKeyboard.swift).

## Working native paths

- Native login against the real authenticated server; screen startup and real desktop image delivery.
- Keyboard-open/closed layouts preserve the **1280:800** desktop aspect ratio and keep the desktop above the keyboard.
- Direct keyboard typing, Return and Backspace reach the remote text field in order.
- Clipboard typing: a deliberately failed request retains the entered text; retry succeeds once and closes the sheet.
- A direct touch at the center/lower portion of the native image arrives at the expected **640,560** remote coordinate.
- Five held right-clicks from idle, a real drag with the left button down, button release, and pinch zoom pass.
- Connection loss shows the cached-screen warning and blocks pointer and keyboard input; reconnect removes the warning.
- Pause blocks remote input; Resume restores interaction.
- Backgrounding releases the actual control lease. After foregrounding, the keyboard can acquire control again. An external lease release hides the keyboard. Closing the viewer returns to chat and releases control.
- Unauthenticated requests to status, frame, actions and takeover each return **401**.
- Additional real API checks preserve `café Ω 東京 🙂` plus a newline exactly, scroll the actual page, and release the lease.

The first foreground checks tapped before the button was hittable after activation. The final test waits for a hittable control and runs with a freshly installed test runner; it passes. Those earlier failures remain in the result bundles and are not listed as a confirmed app defect.

## Underlying VNC transport

The dedicated noVNC probe passes authentication, removal of the password from the visible URL, remote keyboard input, remote right-click, disconnect/reconnect, reload/reconnect, view-only input blocking, and wrong-password rejection. The credential is passed through stdin and is not included in the evidence.

The animation observation **did not meet the probe's target** of at least four distinct canvas images in three seconds: it observed **two**. A separate capture shows the changing counter eventually updating, so the stream is live; smooth animation is not certified. This was a local disposable runtime under QA load, not a physical-device or WAN frame-rate benchmark. The failed cadence assertion is preserved in `vnc-transport-verified.json` rather than relabeled as a pass.

An initial connection timeout was caused by the test's WebSocket subclass wrapper being incompatible with noVNC's interface check. A plain connection succeeded; the final observer preserves the native socket instance. That instrumentation failure is not counted as a product defect.

## Three-screen comparison

The original user photos are copied unchanged into `reference/`, with hashes in `reference-manifest.json`. Native screenshots are also unedited. The gallery scales both images to the same display width; desktop window contents differ because these are real QA workspaces. Our own robot remains in the native header.

Approximate positions normalized to a 440-point-wide phone:

| Element | Reference | Native | Difference |
| --- | --- | --- | --- |
| Desktop top, keyboard closed | 340 pt | 349.7 pt | About 10 pt too low |
| Desktop top, keyboard open | 186 pt | 207.7 pt | About 22 pt too low |
| Desktop height | 275 pt | 275 pt | Aspect ratio matches |
| Loading text top | 489 pt | 530 pt | About 41 pt too low |
| Bottom controls, keyboard closed | About 38 pt diameter, center around 907 pt | 44 pt diameter, center 888 pt | Larger and higher |

Native Liquid Glass remains in use. A representative interior patch of the back button is **RGB 32,32,32** in both the reference and native capture against the black backdrop. This checks settled appearance, not a numeric material-opacity value or translucency over moving content.

## Results and reproduction

Latest outcome per native scenario: **3 passed, 3 failed**. Results span the following bundles; this is not a claim that one full suite passed:

- `NativeVNC-Live.xcresult`: 1 passed, 4 failed. Three failures are the rapid hold, trackpad and two-finger findings; the other was the early foreground tap.
- `NativeVNC-Followup.xcresult`: 2 passed, 1 failed. Startup/input/retry and direct drag/zoom/idle holds pass. Its foreground failure reported the earlier assertion location and did not execute the new readiness wait, indicating a stale first runner; the fresh-run result below is the acceptance evidence.
- `Foreground-Acceptance.xcresult`: 1 passed, 0 failed, 0 skipped, after waiting for foreground readiness and reinstalling the test runner.
- `NativeVNC-Audit.xcresult` contains earlier harness setup failures (probe not ready); it is not product acceptance evidence.

All artifacts are under `output/swift-vnc-qa-0916/`. They include Xcode summaries, UI screenshots/accessibility trees, actual browser event receipts, authenticated-API status checks, and VNC transport observations. Application source was unchanged in this pass; only opt-in QA tests, harnesses and documentation were added or corrected. The temporary services are stopped after collection.

The `VNCValidation` scheme is excluded from ordinary fixture verification. To repeat, start `real-server-qa.ts` with `SWIFT_REAL_QA_OUTPUT=output/swift-vnc-new-run SWIFT_VNC_QA=1`, create a disposable bot through the control API, and open its Chromium screen. Copy/run `vnc-desktop-probe.ts` inside the disposable computer on that screen's X display, start `vnc-qa-proxy.ts` with `SWIFT_VNC_QA_BOT_ID`, and run the scheme on an isolated simulator. The probe operates on an inert page and must never be pointed at a production computer. `vnc-transport-probe.ts` separately exercises the actual viewer using its transient credential on stdin.

Not covered: physical-device multi-touch/haptics, cellular/WAN latency, rotation/iPad layouts, a long soak test, and a streaming VNC implementation inside Swift. The earlier full-app audit findings remain open.
