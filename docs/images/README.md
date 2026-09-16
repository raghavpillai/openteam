# README screenshots

`openteam-desktop-mobile.png` combines real interface captures, with the desktop on the left
and the iPhone on the right. The desktop takes approximately 78% of the combined screenshot
width. Both apps show the same sample task: compare three vendors, save a recommendation,
and schedule a weekday pricing check. The vendors and prices are illustrative.

- `openteam-desktop.png`: captured on September 16, 2026 from the current desktop components
  rendered by `apps/desktop/test/browser/landing-reference.tsx` in README mode in a native Electron window.
  The window uses the app's `hiddenInset` title bar and traffic-light position, so the macOS
  window controls are part of the capture. Its 1344 × 817 layout is 30% narrower than the
  previous 1920-pixel capture. The capture tool's image is normalized to the window's logical
  dimensions and saved as PNG. The fixture uses the shipping sidebar, chat, inspector, fonts,
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

The composite keeps the desktop at 1344 × 817 and scales the mobile capture proportionally
to 376 × 817. A 28-pixel gap, 32-pixel outer margin, neutral background, rounded corners, and
thin borders frame the screenshots. The final image is 1812 × 881 pixels. App content has
not been redrawn or generated. To exclude the capture tool's pointer marker, the desktop
combines the unobstructed title bar and conversation area from two captures of the same window.

## Capturing again

Run the desktop Vite server and open `/test/browser/landing-reference.html?readme` in an
Electron window configured with the dimensions and title bar above. For iPhone, bundle
`test/readme/entry.tsx` from `apps/mobile` using `expo export:embed --platform ios`; include
the exported assets in the simulator app, especially `www.bundle` for rich Markdown. Use a
fresh simulator so existing connections and conversations cannot enter the capture.

Capture both apps after the content has loaded, then scale and frame the images using the
dimensions above. Keep the native controls, and check that every message and the computer
preview are visible before replacing the README image.
