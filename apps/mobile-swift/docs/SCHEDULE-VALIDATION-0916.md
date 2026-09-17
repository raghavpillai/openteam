# Native schedule picker validation

Validated September 16–17, 2026 on the dedicated iPhone 16 Pro Max simulator, iOS 26.5.

The routine editor now uses the desktop's common schedule choices: Every hour, Every day, Weekdays, Every week, Every month, and Interval. Time, weekday, month day, minute, and interval values use native menu pickers. Both the editor and routine list display readable summaries instead of cron strings. New routines default to weekdays at 8 AM, matching desktop.

The time picker uses desktop's 15-minute choices; previously saved times outside those choices remain available without rounding. Interval choices match desktop. Monthly schedules explain when a selected day does not exist in every month. Choosing a frequency dismisses the text keyboard, and scrolling can dismiss it interactively.

Existing pinned time zones remain pinned, installation-zone schedules remain unpinned, and new calendar schedules use the device's zone. Unchanged schedules are omitted from updates. Custom, event, and grouped triggers survive unrelated edits, including desktop's stored advanced-editor presentation. Advanced/group authoring remains available on desktop; native does not replace those rules with a simpler schedule unless the user explicitly selects a supported replacement for a single custom schedule.

## Verification

| Check | Result |
| --- | --- |
| Four schedule UI scenarios in light/dark mode | Passed |
| Existing create/revision-conflict/run regression | Passed |
| Accepted run with lost response, deduplicated retry, and history recovery | Passed |
| Swift core tests, including six new schedule tests | 42 passed |
| Desktop and production server routine tests | 15 passed |

UI coverage includes all six frequency choices; monthly/hourly/interval save and reopen; weekly day/time selection; failed-save retry without duplicates; a saved 9:17 AM time and Europe/Rome zone; custom/group preservation; and unchanged desktop presentation on a name edit. The verified run also recorded selection feedback for every new picker, save success feedback, and save error feedback through the shared haptics policy.

This pass used a running loopback HTTP fixture for UI tests and the production server's scheduling tests. It did not wait for a new task to execute on a live production server. Simulator haptic dispatch does not measure physical vibration.

## Evidence

- [Screenshot review](../../../output/swift-schedule-0916/review.html)
- [Schedule UI result](../../../output/swift-schedule-0916/Schedule-Validated.xcresult)
- [Routine regression result](../../../output/swift-schedule-0916/Routine-Regressions.xcresult)
- [Core test log](../../../output/swift-schedule-0916/core-final.log)
- [Desktop/server test log](../../../output/swift-schedule-0916/desktop-server-tests-verified.log)
- [Verified haptic dispatch](../../../output/swift-schedule-0916/verified-haptic-dispatch.json)

Source references: `Sources/App/RoutineScheduleFields.swift`, `Sources/App/RoutinesView.swift`, `Sources/Core/RoutineSchedule.swift`, and desktop `apps/desktop/src/renderer/components/openteam/routine-panel.tsx` / `lib/routines.ts`.

Run the `RoutineSchedule` Xcode scheme against `SWIFT_PARITY_PORT=20032 bun apps/mobile-swift/scripts/parity-server.ts`. Existing `FunctionalFlowUITests` routine regressions use port 19992. Both fixtures are isolated and were stopped after this pass.
