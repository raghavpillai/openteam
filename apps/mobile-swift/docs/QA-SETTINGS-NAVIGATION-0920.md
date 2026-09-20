# Native Settings navigation fix — September 20, 2026

Account and Plugins had dead tap regions in the custom Settings cards. Their plain-styled navigation labels did not make the full visible card an interactive row. Coordinate taps in empty space reproduced both failures; tapping the text alone was insufficient QA.

The root panel now uses SwiftUI's native inset-grouped List, Sections, NavigationLinks, navigation bar and Close toolbar action. Account and Plugins labels explicitly fill their rows. The notifications control uses the list's native row surface instead of a nested custom card. Native back navigation, app palette and the red Re-auth action remain intact. The Close symbol uses the semantic primary foreground so it stays legible in dark mode.

Fresh simulator validation on iOS 26.5:

- Account and Plugins: four horizontal tap coordinates (10%, 50%, 80%, 95%) in both light and dark mode on 440-point and 390-point iPhone layouts; native Back, Close and reopening the panel.
- Existing dark Account/Re-auth test, plugin installation/connection-failure recovery test, and invalid-server reconnect/sidebar-save-retry test all passed.
- Five distinct UI cases / eight successful executions including the final Close-contrast rerun. Two before-fix coordinate cases failed as expected. Screenshots were visually inspected; no physical-device run is claimed.
- Swift Core: 79 passed. RN/shared suites: 407 passed. `git diff --check` passed.

Evidence: `output/rn-swift-parity-0920/SettingsBefore.xcresult`, `SettingsAfter.xcresult`, `SettingsCompact.xcresult`, `SettingsFlows.xcresult`, `SettingsFinal.xcresult` and their logs/captures. `settings-dark.png` and `settings-light.png` are final Settings screenshots; Account/Plugins destination captures are in `settings-compact-attachments/`.

The separate [React Native–Swift audit](RN-SWIFT-PARITY-0920.md) lists remaining functional differences. Those are not fixed by this navigation change.
