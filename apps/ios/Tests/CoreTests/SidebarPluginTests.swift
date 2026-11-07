import XCTest
@testable import OpenTeamCore

final class SidebarPluginTests: XCTestCase {
  func testSnapshotRetainsOnlyPresentationAndDeduplicatesInstalls() throws {
    let response: JSON = .object([
      "catalog": .array([.object(["key": .string("custom"), "name": .string("Custom app"),
        "logoUrl": .string("data:image/png;base64,YQ==")])]),
      "installs": .array([
        .object(["pluginKey": .string("slack"), "name": .string("Slack"),
          "connections": .array([.object(["status": .string("connected"), "token": .string("private")])]),
          "logoUrl": .string("https://unavailable.example/slack.png")]),
        .object(["pluginKey": .string("slack")]),
        .object(["key": .string("custom")]),
      ]),
    ])
    let icons = try XCTUnwrap(SidebarPlugin.snapshot(response))
    XCTAssertEqual(icons.map(\.id), ["slack", "custom"])
    XCTAssertEqual(icons.last?.name, "Custom app")
    XCTAssertEqual(icons.last?.logo, "data:image/png;base64,YQ==")
    XCTAssertNil(icons.first?.logo)
    let serialized = String(decoding: try JSONEncoder().encode(icons), as: UTF8.self)
    XCTAssertFalse(serialized.contains("private"))
    XCTAssertFalse(serialized.contains("connected"))
    XCTAssertFalse(serialized.contains("https://"))
  }

  func testMalformedResponsesCannotEraseSavedIconsButConfirmedEmptyCan() {
    XCTAssertNil(SidebarPlugin.snapshot(.object([:])))
    XCTAssertNil(SidebarPlugin.snapshot(.object(["installs": .null])))
    XCTAssertNil(SidebarPlugin.snapshot(.object(["installs": .array([.object([:])])])))
    XCTAssertEqual(SidebarPlugin.snapshot(.object(["installs": .array([])])), [])
  }

  func testIconsSurviveRelaunchAndAreIsolatedByAccountAndServer() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let account = try DiskStore(directory: directory, scope: "server-a/user-a")
    var state = SavedState()
    state.sidebarPlugins = SidebarPlugin.snapshot(.object(["installs": .array([
      .object(["key": .string("slack"), "name": .string("Slack")]),
    ])]))
    try account.save(state)
    XCTAssertEqual(try account.load().sidebarPlugins?.first?.id, "slack")
    XCTAssertNil(try DiskStore(directory: directory, scope: "server-a/user-b").load().sidebarPlugins)
    XCTAssertNil(try DiskStore(directory: directory, scope: "server-b/user-a").load().sidebarPlugins)
    try account.clear()
    XCTAssertNil(try account.load().sidebarPlugins)
  }

  func testOldCachesRemainReadable() throws {
    let old = Data(#"{"messages":{},"drafts":{},"outbox":[]}"#.utf8)
    XCTAssertNil(try JSONDecoder().decode(SavedState.self, from: old).sidebarPlugins)
  }
}
