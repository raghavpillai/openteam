# OpenTeam app icons

`OpenTeam.icon` is the shared, editable Icon Composer source for iOS and macOS.
It preserves the Classic 2D bot from `src/robot-avatar-artwork.ts`, including the
slight face perspective. Colors are defined in `icon.json`; the SVG layers are
plain vector masks. Layer order is foreground first: eyes, face, body.

The body uses a subtle teal gradient. The default background runs from near-white
to light gray; the dark background runs from charcoal to near-black. Apple adds
the platform mask and background lighting. The robot's specular effect is disabled
to keep the mark flat and avoid a heavy bevel. Clear and tinted appearances use
the system's native conversion of the same layers.

## Build integration

- iOS: Expo's `ios.icon` and the checked-in Xcode project reference `OpenTeam.icon`.
  Xcode compiles the layered appearances and generates older-OS fallback icons.
  Home Screen appearance is controlled by the user's icon customization setting,
  independently of the app's own theme.
- macOS: electron-builder compiles the `.icon` into `Assets.car`, includes a legacy
  ICNS, and writes the native icon keys into Info.plist. Do not replace it with
  `app.dock.setIcon`, which bypasses the system's appearance selection.
- Windows: `icon.ico` includes 16, 24, 32, 48, 64, 128 and 256px representations.
- Linux: `openteam-desktop-light.png` is the packaged icon. Windows and Linux use
  static icons; light and dark PNG exports are available for both.
- In-app About screens: generated opaque PNGs in `apps/mobile/assets` follow the
  resolved light/dark theme. The light PNG is also Expo's generic fallback.

The native PNGs here are flattened previews with platform masking. Do not use them
as opaque iOS App Store asset-catalog inputs. Use the `.icon` source instead.
The standalone `icon.icns` contains the full set of 16–1024px representations and
the Mac's outer padding, and is used by the DMG.

## Regenerate

From the repository root on macOS with Xcode 26+ selected and dependencies installed:

```sh
bun scripts/branding/export-app-icons.ts
bun scripts/branding/export-mobile-icon-fallbacks.ts
bun test ./apps/mobile/test/native-assets.test.ts ./apps/desktop/test/macos-release.test.ts
```

The mobile fallback exporter uses macOS `sips` SVG support and Core Graphics to
write full-bleed, opaque RGB PNGs. Rebuild/reinstall the apps to see new system
icons; updating JavaScript alone cannot update a Home Screen or Dock icon.

## Design references

- [Apple app icon guidelines](https://developer.apple.com/design/human-interface-guidelines/app-icons)
- [Creating icons with Icon Composer](https://developer.apple.com/documentation/xcode/creating-your-app-icon-using-icon-composer)
- [Apple's new app icon appearances](https://developer.apple.com/videos/play/wwdc2025/220/)
- [ChatGPT on the App Store](https://apps.apple.com/us/app/chatgpt/id6448311069)
- [Messages on the App Store](https://apps.apple.com/us/app/messages/id1146560473)
