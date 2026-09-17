# Light and dark color validation — September 16, 2026

The native iPhone app now uses one shared palette for chat, settings, grouped forms and lists, plugin and routine screens, authentication, rich cards, and offline documents. This follows the supplied Grok Bot references while retaining OpenTeam's robot identities and native Liquid Glass.

## Changes

- Corrected dark cards from warm `#242422` to the reference's neutral `#202020`. Assistant bubbles and grouped cards share the surface token.
- Applied the shared background, row fill and divider colors to native forms and lists, including deeper account, plugin, routine and preference pages. These no longer fall back to different UIKit grouped fills.
- Routed app secondary labels and action/status colors through the palette. The root supplies primary, secondary and tertiary foreground styles.
- Set the shared blue action color to reference RGB `1, 108, 236` (`#016CEC`); the simulator's default iOS blue was visibly brighter. Disabled primary fills use the measured light `#848484` and dark `#9A9A9A` values. Primary button symbols use white/black, independently of the off-white/charcoal page backgrounds.
- Passed the resolved Swift palette into the offline WebKit renderer. Document text, links, code, tables, rules, quotes and diagram nodes now use the same roles as native content, including white text for user messages in light mode. Rebuilt the bundled offline renderer from source.

| Role | Light | Dark |
| --- | --- | --- |
| Page background | `#FCFCFC` | `#141414` |
| Card / assistant bubble | `#F2F2F2` | `#202020` |
| Main text | `#000000` | `#FFFFFF` |
| Primary button text | `#FFFFFF` | `#000000` |
| Secondary text | `#8E8E8E` | `#8E8E93` |
| Tertiary text | `#BFBFBF` | `#666666` |
| User bubble | `#0A0A0A` | `#5C5C5C` |
| Divider | `#E4E4E4` | `#343434` |
| Code / selection surface | `#E5E5E5` | `#2C2C2C` |
| Blue action | `#016CEC` | `#016CEC` |
| Disabled primary fill | `#848484` | `#9A9A9A` |

## Validation

Final device: owned iPhone 16 Pro Max simulator, iOS 26.5. Fixture servers are loopback-only, with inert content. No live external messages, plugin accounts or scheduled tasks were created by this color pass.

- `output/swift-colors-0916/Palette-Final.xcresult`: **3 passed, 0 failed, 0 skipped**. Covers settings and nested account forms through light → dark → light without restarting, home/create screens, chat long press and reply drafts in both themes, and offline Markdown/table/math/diagram rendering in both themes.
- `output/swift-colors-0916/Regressions.xcresult`: **4 passed, 0 failed, 0 skipped**. Covers rejected login then retry, plugin load/install/connection failure recovery, user-form validation and successful submission, and routine creation/conflict recovery/run.
- Eight original-image patch comparisons match exactly: light/dark grouped cards, dark page background, dark assistant/user bubbles, resting dark composer, and light/dark disabled primary fills. All repeated native settings/account captures retain the expected fill after theme changes.
- Inspected final native screenshots of chat, settings, nested forms, creation, reply input, and rendered documents. Swift formatting completed after the behavior checks; it made no semantic changes.

[Original-image comparison](../../../output/swift-colors-0916/review.html), [sample coordinates and RGB values](../../../output/swift-colors-0916/measurements.json), [capture provenance](../../../output/swift-colors-0916/manifest.json).

## Exactness and remaining scope

This establishes shared color roles and the measured solid-fill matches, not pixel-for-pixel equivalence of every screen. The photos do not cover every application state. JPEG compression and antialiased text prevent reliable recovery of every original color or opacity from a screenshot. Green toggles, warning/destructive colors, system menus, keyboards, dialogs and native materials retain platform behavior. Glass tint and scroll-edge effects are unchanged from the previously validated implementation; their composited colors adapt to content, appearance and accessibility settings. The existing system-menu and keyboard differences remain recorded in `SEVEN-SCREEN-VALIDATION-0916.md`.

Robot artwork and user-selected robot colors are unchanged. The launch cover remains pure black/white with the thinking robot and shadow; the computer viewport remains black. Earlier functionality and layout findings in the QA reports are not closed by these color changes.

## Reproduce

Start `SWIFT_PARITY_PORT=20029 bun apps/mobile-swift/scripts/parity-server.ts`, then run the `Palette` Xcode scheme. Export the result with:

```sh
/opt/homebrew/bin/python3.12 apps/mobile-swift/scripts/export-palette-review.py output/swift-colors-0916 --bundle output/swift-colors-0916/Palette-Final.xcresult
```

The exporter uses Pillow to inspect original pixels, asserts the eight comparisons and theme round-trip card fills, and copies reference files without alteration. The HTML only changes their display width; it performs no image retouching or recoloring.
