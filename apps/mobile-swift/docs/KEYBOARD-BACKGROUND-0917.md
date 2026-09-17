# Keyboard background — September 17, 2026

The native chat exposed pure black (`#000000`) around the iOS keyboard's rounded corners in dark mode. The surrounding page and Grok Bot reference both use `#141414`. Light mode exposed white bottom corners instead of the page's `#FCFCFC`.

The page's style background stopped at the keyboard region. Giving the outer app root a full-screen background did not fix it through the navigation container. Extending the page's background view with `ignoresSafeArea()` did: only the color extends under the keyboard, while content still adjusts above it. This follows Apple's [background and keyboard layout guidance](https://developer.apple.com/documentation/swiftui/adding-a-background-to-your-view).

`nativeCanvas()` now applies that behavior to chat, home/search, bot creation, settings/profile, sign-in and shared native forms/lists. The VNC surface remains intentionally black. Keyboard rendering, Liquid Glass parameters, palette values and launch animation are unchanged.

## Focused validation

- Native iPhone 16 Pro Max simulator, iOS 26.5; inert local HTTP fixture server.
- Chat reply entry and text preservation in light and dark appearances.
- Keyboard-up sign-in, search, bot creation and profile screens in both appearances; fields and creation controls remain above the keyboard.
- Final focused UI run: 2 tests, 0 failures; all 10 final screenshots pass corner pixel checks. Dark corners are RGB 20/20/20, light bottom corners are RGB 252/252/252. Native shadows remain at the light top corners.
- Original before/after captures and corner RGB measurements: `output/swift-keyboard-0917/review/review.html` and `measurements.json`.
- Reference: attachment set `57935E3D-22A4-4D48-97E8-493BFDC2D278`, photo 3; all four exposed dark corners measure RGB 20/20/20.

This validates the keyboard canvas change, not all mobile functionality or physical-device behavior. Broader open findings remain in [QA status](QA-STATUS-0917.md).
