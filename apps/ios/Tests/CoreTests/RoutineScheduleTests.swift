import XCTest

@testable import OpenTeamCore

final class RoutineScheduleTests: XCTestCase {
  func testDesktopPresetsRoundTripWithoutRoundingSavedTimes() {
    let cases: [(String, RoutineScheduleDraft.Frequency)] = [
      ("7 * * * *", .hourly), ("17 13 * * *", .daily), ("0 8 * * 1-5", .weekdays),
      ("45 23 * * 0", .weekly), ("15 6 31 * *", .monthly), ("@every 17m", .interval),
      ("@every 2h", .interval), ("@every 7d", .interval),
    ]
    for (raw, frequency) in cases {
      let draft = RoutineScheduleDraft(schedule: raw)
      XCTAssertEqual(draft.frequency, frequency, raw)
      XCTAssertEqual(draft.scheduleValue(), raw)
      XCTAssertNil(draft.scheduleUpdate(original: raw, editable: true, newTimeZone: "UTC"))
    }
    XCTAssertTrue(RoutineScheduleDraft.options([0, 15, 30, 45], including: 17).contains(17))
  }

  func testNewSchedulesUseDeviceZoneButExistingInstallationSchedulesStayUnpinned() {
    var draft = RoutineScheduleDraft()
    XCTAssertEqual(
      draft.scheduleUpdate(original: nil, editable: true, newTimeZone: "Europe/Rome"),
      "CRON_TZ=Europe/Rome 0 8 * * 1-5")
    draft = RoutineScheduleDraft(schedule: "0 9 * * 1-5")
    draft.frequency = .weekly
    draft.weekDay = 5
    XCTAssertEqual(
      draft.scheduleUpdate(original: "0 9 * * 1-5", editable: true, newTimeZone: "UTC"),
      "0 9 * * 5")
  }

  func testPinnedTimeZoneAndWallClockSurviveEditsWithoutDSTConversion() {
    for prefix in ["CRON_TZ=America/New_York", "TZ=Europe/Rome"] {
      let original = "\(prefix) 30 2 * * *"
      var draft = RoutineScheduleDraft(schedule: original)
      XCTAssertEqual(draft.time, 150)
      XCTAssertEqual(draft.pinnedTimeZone, String(prefix.split(separator: "=")[1]))
      XCTAssertNil(draft.scheduleUpdate(original: original, editable: true, newTimeZone: "UTC"))
      draft.frequency = .weekdays
      XCTAssertEqual(
        draft.scheduleUpdate(original: original, editable: true, newTimeZone: "UTC"),
        "\(prefix) 30 2 * * 1-5")
      draft.frequency = .interval
      draft.intervalAmount = 2
      draft.intervalUnit = .hours
      XCTAssertEqual(draft.scheduleValue(), "@every 2h")
    }
  }

  func testUnsupportedRulesAndMalformedValuesNeverBecomeSimplerSchedules() {
    for raw in [
      "0 9 15 * 1", "0 9 * 1 *", "*/15 9-17 * * 1-5", "@every 1h/5m",
      "60 9 * * *", "0 24 * * *", "0 9 32 * *", "0 9 * * 8", "@every 0m",
    ] {
      let draft = RoutineScheduleDraft(schedule: raw)
      XCTAssertEqual(draft.frequency, .existing, raw)
      XCTAssertEqual(draft.scheduleValue(), raw)
      XCTAssertNil(draft.scheduleUpdate(original: raw, editable: true, newTimeZone: "UTC"))
    }
    var draft = RoutineScheduleDraft(schedule: "*/15 9-17 * * 1-5")
    draft.frequency = .daily
    XCTAssertEqual(draft.scheduleValue(), "0 8 * * *")
    draft.frequency = .existing
    XCTAssertEqual(draft.scheduleValue(), "*/15 9-17 * * 1-5")
    // Native edits to a composite/event routine must omit the trigger even if local state changed.
    draft.frequency = .weekly
    XCTAssertNil(draft.scheduleUpdate(original: "0 9 * * *", editable: false, newTimeZone: "UTC"))
  }

  func testSundayAliasIsPreservedUntilUserChangesItAndUnitChangesStayValid() {
    var draft = RoutineScheduleDraft(schedule: "0 9 * * 7")
    XCTAssertEqual(draft.frequency, .weekly)
    XCTAssertEqual(draft.weekDay, 0)
    XCTAssertNil(draft.scheduleUpdate(original: "0 9 * * 7", editable: true, newTimeZone: "UTC"))
    draft = RoutineScheduleDraft(schedule: "@every 17m")
    draft.changeUnit(to: .hours)
    XCTAssertEqual(draft.intervalAmount, 1)
    draft.intervalAmount = 2
    draft.changeUnit(to: .days)
    XCTAssertEqual(draft.intervalAmount, 2)
    draft.changeUnit(to: .minutes)
    XCTAssertEqual(draft.intervalAmount, 30)
  }
}
