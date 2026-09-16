# README screenshots

`openteam-desktop-mobile.png` combines real interface captures, with the desktop on the left
and the iPhone on the right. The desktop takes approximately 78% of the combined screenshot
width. The conversations are sample data.

- `openteam-desktop.png`: captured on September 15, 2026 from the current desktop components
  rendered by `apps/desktop/test/browser/landing-reference.tsx` in a native Electron window.
  The window uses the app's `hiddenInset` title bar and traffic-light position, so the macOS
  window controls are part of the capture. Its 1344 × 817 layout is 30% narrower than the
  previous 1920-pixel capture. The capture tool's image is normalized to the window's logical
  dimensions and saved as PNG. The fixture uses the shipping sidebar, chat, inspector, fonts,
  and styles with sample data; it does not connect to accounts or run bot tasks.
- The mobile source is the existing native iPhone capture at
  [`apps/landing/public/screenshots/openteam-mobile-chat.png`](../../apps/landing/public/screenshots/openteam-mobile-chat.png).

The composite keeps the desktop at 1344 × 817 and scales the mobile capture proportionally
to 376 × 817. A 28-pixel gap, 32-pixel outer margin, neutral background, rounded corners, and
thin borders frame the screenshots. The final image is 1812 × 881 pixels. App content has
not been redrawn or generated. The cursor highlight was removed by copying adjacent empty
title-bar pixels over it; the rest of the desktop capture is unchanged.
