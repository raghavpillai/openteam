import XCTest

@testable import OpenTeamCore

final class ServerUpdateTests: XCTestCase {
  func testActiveProgressSurvivesNewReaderAndIsScopedAndExpires() throws {
    let suite = "server-update-tests-" + UUID().uuidString
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let now = Date(timeIntervalSince1970: 10000)
    let update = try JSON.object([
      "status": .string("updating"), "phase": .string("restarting"),
      "jobId": .string("external-job"), "targetVersion": .string("0.0.11"),
      "updaterAvailable": .bool(true), "safeToCloseDesktop": .bool(true),
    ]).decode(ServerUpdateStatus.self)
    let snapshot = ServerUpdateSnapshot(
      release: nil, update: update, observedAt: now, startedAt: now.addingTimeInterval(-10))
    ServerUpdateCache.save(snapshot, server: "https://one.example", defaults: defaults)
    let restored = ServerUpdateCache.load(
      server: "https://one.example", defaults: defaults, now: now)
    XCTAssertEqual(restored?.update.jobId, "external-job")
    XCTAssertEqual(restored?.update.phase, "restarting")
    XCTAssertEqual(restored?.startedAt, now.addingTimeInterval(-10))
    XCTAssertNil(
      ServerUpdateCache.load(server: "https://two.example", defaults: defaults, now: now))
    XCTAssertNil(
      ServerUpdateCache.load(
        server: "https://one.example", defaults: defaults, now: now.addingTimeInterval(86401)))
    XCTAssertNil(
      ServerUpdateCache.load(
        server: "https://one.example", defaults: defaults, now: now.addingTimeInterval(-1)))
    ServerUpdateCache.save(nil, server: "https://one.example", defaults: defaults)
    XCTAssertNil(
      ServerUpdateCache.load(server: "https://one.example", defaults: defaults, now: now))
  }

  func testUpdateMilestonesFollowHostPhasesWithoutInventingPercentages() {
    let phases = [
      "checking", "downloading", "pulling", "backing-up", "restarting", "verifying", "updating-cli",
      "complete",
    ]
    XCTAssertEqual(phases.map { ServerUpdateProgress(phase: $0).step }, [0, 1, 1, 2, 3, 4, 4, 5])
    XCTAssertEqual(ServerUpdateProgress(phase: "backing-up").title, "Protecting your data")
    XCTAssertNil(ServerUpdateProgress(phase: "future-phase").step)
    XCTAssertTrue(ServerUpdateProgress(phase: "rolling-back").rollingBack)
    XCTAssertNil(ServerUpdateProgress(phase: "rolling-back").step)
  }
  private func policy(
    _ server: String, client: String = "0.0.11", protocolVersion: Int = 2,
    minimum: String = "0.0.0", maximum: String = "0.1.0"
  ) throws -> ServerUpdatePolicy {
    let release = try JSON.object([
      "releaseVersion": .string(server), "apiProtocolVersion": .number(Double(protocolVersion)),
      "minimumClientVersion": .string(minimum), "maximumClientVersionExclusive": .string(maximum),
    ]).decode(ServerRelease.self)
    return ServerUpdatePolicy(clientVersion: client, release: release)
  }

  func testOlderCompatibleServerTargetsInstalledAppWithoutReleaseFeed() throws {
    let result = try policy("0.0.10")
    XCTAssertEqual(result.compatibility, .recommended)
    XCTAssertEqual(result.targetVersion, "0.0.11")
    XCTAssertEqual(try policy("v0.0.10+build.2").targetVersion, "0.0.11")
  }

  func testMatchingAndNewerServersNeverOfferDowngrades() throws {
    XCTAssertEqual(try policy("0.0.11").compatibility, .compatible)
    XCTAssertNil(try policy("0.0.11").targetVersion)
    XCTAssertNil(try policy("0.0.12").targetVersion)
    XCTAssertNil(try policy("0.0.12", protocolVersion: 1).targetVersion)
    XCTAssertEqual(try policy("0.0.11", protocolVersion: 3).compatibility, .clientRequired)
    XCTAssertNil(try policy("0.0.10", minimum: "0.0.12").targetVersion)
    XCTAssertEqual(try policy("0.0.10", protocolVersion: 1).compatibility, .serverRequired)
  }

  func testUnknownAndInvalidVersionsCannotEnableUpdates() throws {
    XCTAssertEqual(
      ServerUpdatePolicy(clientVersion: "0.0.11", release: nil).compatibility, .unknown)
    for version in [
      "", "0.0", "00.0.11", "0.0.11-beta.01", "0.0.11;echo nope", "9007199254740992.0.0",
    ] {
      XCTAssertNil(OpenTeamVersion(version), version)
      XCTAssertNil(try policy(version).targetVersion, version)
      XCTAssertNil(try policy("0.0.10", client: version).targetVersion, version)
    }
  }

  func testSemverPrereleaseOrderingAndBuildNormalization() throws {
    XCTAssertEqual(OpenTeamVersion("v1.2.3+build.2"), OpenTeamVersion("1.2.3"))
    let ordered = [
      "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta",
      "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.1.0", "2.0.0",
    ]
    for pair in zip(ordered, ordered.dropFirst()) {
      XCTAssertLessThan(
        try XCTUnwrap(OpenTeamVersion(pair.0)), try XCTUnwrap(OpenTeamVersion(pair.1)))
    }
    XCTAssertEqual(try policy("0.0.11-beta.2").targetVersion, "0.0.11")
  }
}
