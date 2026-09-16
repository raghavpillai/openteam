# README screenshots

`openteam-desktop-mobile.png` combines real interface captures, with the desktop on the left
and the iPhone on the right. The desktop takes approximately 78% of the combined screenshot
width. Both apps show the same sample task: compare three vendors, save a recommendation,
and schedule a weekday pricing check. The vendors and prices are illustrative.

- `openteam-desktop.png`: captured on September 16, 2026 from the current desktop components
  rendered by `apps/desktop/test/browser/landing-reference.tsx` in README mode in a native Electron window.
  The window uses the app's `hiddenInset` title bar and traffic-light position. Its logical
  1344 × 817 layout is 30% narrower than the previous 1920-pixel capture. Electron renders
  the interface at a device scale factor of 2 and captures it directly as a 2688 × 1634 PNG,
  without enlarging a lower-resolution app capture. The real macOS controls are captured
  separately at the screen's native 1× density; only that small control crop is scaled and
  aligned over the renderer capture, which excludes native window chrome.
  The fixture uses the shipping sidebar, chat, inspector, fonts,
  and styles with sample data; it does not connect to accounts or run bot tasks. Its computer
  preview displays the real Linux capture at
  [`apps/landing/public/screenshots/linux-vendor-review.png`](../../apps/landing/public/screenshots/linux-vendor-review.png).
- `openteam-mobile.png`: captured on September 16, 2026 in a fresh iPhone 17 Pro simulator
  running the native app's chat screen. The screenshot entry point is
  [`apps/mobile/test/readme/entry.tsx`](../../apps/mobile/test/readme/entry.tsx); its separate
  route layout supplies sample state without connecting to a server or changing app authentication.
  The native capture is 1206 × 2622 pixels, with the status bar set to 9:41.
- Both screenshot fixtures read
  [`scripts/screenshots/readme-conversation.json`](../../scripts/screenshots/readme-conversation.json)
  so their conversations stay consistent.

The composite keeps the desktop at 2688 × 1634 and reduces the original mobile capture
to 752 × 1634. A 56-pixel gap, 64-pixel outer margin, neutral background, rounded corners, and
thin borders frame the screenshots. The final image is 3624 × 1762 pixels, twice the previous
resolution in each dimension, with the same layout and proportions. App content has not
been redrawn or generated. Direct renderer capture excludes the pointer; the native control
crop is also unobstructed.

## Capturing again

Run the desktop Vite server and open `/test/browser/landing-reference.html?readme` in an
Electron window configured with the logical dimensions and title bar above. Through Electron's
debugger API, use `Emulation.setDeviceMetricsOverride` with `width: 1344`, `height: 817`,
`deviceScaleFactor: 2`, and `mobile: false`. Wait for fonts and images to load, then use
`Page.captureScreenshot` with `format: "png"` and `fromSurface: true`. Verify that the result
is 2688 × 1634; a regular window capture may return only the screen's 1× resolution.
Preserve the native controls with an unobstructed crop from the same Electron title bar,
scaling that crop to match the renderer's pixel density. For iPhone, bundle
`test/readme/entry.tsx` from `apps/mobile` using `expo export:embed --platform ios`; include
the exported assets in the simulator app, especially `www.bundle` for rich Markdown. Use a
fresh simulator so existing connections and conversations cannot enter the capture.

Capture both apps after the content has loaded, then frame the images using the dimensions
above. Keep the desktop renderer at its captured size; downsample the original iPhone capture.
Keep the native controls, and check that every message and the computer preview are visible
before replacing the README image.
