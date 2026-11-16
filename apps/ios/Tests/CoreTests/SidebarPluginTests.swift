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

}
