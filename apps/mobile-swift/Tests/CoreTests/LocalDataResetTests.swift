import Foundation
import XCTest
@testable import OpenTeamCore

final class LocalDataResetTests: XCTestCase {
  func testErasesEveryAccountAndStagedAttachmentWithoutTouchingOtherRoots() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let data = root.appendingPathComponent("app-data")
    let unrelated = root.appendingPathComponent("unrelated")
    try FileManager.default.createDirectory(at: unrelated, withIntermediateDirectories: true)
    for scope in ["first-account", "previous-server-account"] {
      let disk = try DiskStore(directory: data, scope: scope)
      var saved = SavedState()
      var draft = Draft()
      draft.text = "Private unsent draft"
      draft.stagedFiles = [try disk.stage(Data("private".utf8), fileName: "test.txt", mimeType: "text/plain")]
      saved.drafts["channel"] = draft
      try disk.save(saved)
    }
    try LocalDataReset.erase(directories: [data])
    XCTAssertFalse(FileManager.default.fileExists(atPath: data.path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: unrelated.path))
    let restored = try DiskStore(directory: data, scope: "first-account").load()
    XCTAssertTrue(restored.drafts.isEmpty)
    XCTAssertTrue(restored.outbox.isEmpty)
    XCTAssertTrue(restored.messages.isEmpty)
    try LocalDataReset.erase(directories: [data])
    try LocalDataReset.erase(directories: [data]) // Safe to retry an interrupted reset.
  }
}
