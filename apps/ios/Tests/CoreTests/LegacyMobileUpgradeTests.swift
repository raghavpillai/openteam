import XCTest

@testable import OpenTeamCore

final class LegacyMobileUpgradeTests: XCTestCase {
  private var saved: [String: String] {
    [
      "openteam.server-url.v1": "https://Example.test/bot/",
      "openteam.auth-token-server": "https://example.test/bot",
      "openteam.auth-token": "synthetic-upgrade-token",
      "openteam.auth-token-account": "synthetic-account",
      "openteam.push-installation-id": "96297E1F-42A4-4BDA-9FAA-24900016BC4F",
      "openteam.appearance": "dark", "openteam.accent": "blue", "openteam.haptics": "off",
    ]
  }

  func testRestoresOnlyServerBoundAccountAndPushInstallation() {
    let upgrade = LegacyMobileUpgrade(values: saved)
    XCTAssertEqual(upgrade.server, "https://example.test/bot")
    XCTAssertEqual(upgrade.token, "synthetic-upgrade-token")
    XCTAssertEqual(upgrade.account, "synthetic-account")
    XCTAssertEqual(upgrade.installationID, saved["openteam.push-installation-id"])
    for changedServer in [
      "https://other.test/bot", "https://example.test/other", "http://example.test/bot",
    ] {
      var values = saved
      values["openteam.auth-token-server"] = changedServer
      let rejected = LegacyMobileUpgrade(values: values)
      XCTAssertNil(rejected.token)
      XCTAssertNil(rejected.account)
      XCTAssertNil(rejected.installationID)
      XCTAssertEqual(rejected.server, upgrade.server)
    }
  }

  func testIncompleteOrUnsafeCredentialsCannotMigrate() {
    for key in [
      "openteam.auth-token", "openteam.auth-token-server", "openteam.auth-token-account",
      "openteam.server-url.v1",
    ] {
      var values = saved
      values.removeValue(forKey: key)
      XCTAssertNil(LegacyMobileUpgrade(values: values).token, key)
    }
    var values = saved
    values["openteam.server-url.v1"] = "https://user:password@example.test"
    XCTAssertNil(LegacyMobileUpgrade(values: values).server)
    XCTAssertNil(LegacyMobileUpgrade(values: [:]).token)
  }

  func testPreferencesPreserveOffAndNeverOverwriteNativeEdits() {
    let suite = "upgrade-tests-" + UUID().uuidString
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let upgrade = LegacyMobileUpgrade(values: saved)
    upgrade.applyPreferences(to: defaults)
    XCTAssertEqual(defaults.string(forKey: "appearance"), "dark")
    XCTAssertEqual(defaults.string(forKey: "accent"), "blue")
    XCTAssertEqual(defaults.object(forKey: "haptics") as? Bool, false)
    defaults.set("light", forKey: "appearance")
    defaults.set(true, forKey: "haptics")
    defaults.set("https://new.test", forKey: "server")
    upgrade.applyPreferences(to: defaults)
    XCTAssertEqual(defaults.string(forKey: "appearance"), "light")
    XCTAssertTrue(defaults.bool(forKey: "haptics"))
    XCTAssertEqual(defaults.string(forKey: "server"), "https://new.test")
    XCTAssertNil(LegacyMobileUpgrade(values: [:]).haptics)
    XCTAssertEqual(LegacyMobileUpgrade(values: ["openteam.haptics": "invalid"]).haptics, false)
  }
}
