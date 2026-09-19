import Foundation
import XCTest
@testable import OpenTeamCore

final class LocalDataResetTests: XCTestCase {
  func testClearsContentsWithoutRemovingProtectedSandboxRoot() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let data = root.appendingPathComponent("protected-container/data")
    let parent = data.deletingLastPathComponent()
    defer {
      try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: parent.path)
      try? FileManager.default.removeItem(at: root)
    }
    try FileManager.default.createDirectory(at: data, withIntermediateDirectories: true)
    try Data("private data".utf8).write(to: data.appendingPathComponent("session"))
    try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: parent.path)
    try LocalDataReset.erase(directories: [data])
    XCTAssertTrue(FileManager.default.fileExists(atPath: data.path))
    XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: data.path).isEmpty)
  }
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
    XCTAssertTrue(FileManager.default.fileExists(atPath: data.path))
    XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: data.path).isEmpty)
    XCTAssertTrue(FileManager.default.fileExists(atPath: unrelated.path))
    let restored = try DiskStore(directory: data, scope: "first-account").load()
    XCTAssertTrue(restored.drafts.isEmpty)
    XCTAssertTrue(restored.outbox.isEmpty)
    XCTAssertTrue(restored.messages.isEmpty)
    try LocalDataReset.erase(directories: [data])
    try LocalDataReset.erase(directories: [data]) // Safe to retry an interrupted reset.
  }

  func testFailureStillClearsOtherRootsAndCanBeRetried() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let blocked = root.appendingPathComponent("blocked")
    let writable = root.appendingPathComponent("writable")
    defer {
      try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: blocked.path)
      try? FileManager.default.removeItem(at: root)
    }
    for directory in [blocked, writable] {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      try Data("private".utf8).write(to: directory.appendingPathComponent(".session"))
    }
    try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: blocked.path)
    XCTAssertThrowsError(try LocalDataReset.erase(directories: [blocked, writable]))
    XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: writable.path).isEmpty)
    XCTAssertTrue(FileManager.default.fileExists(atPath: blocked.appendingPathComponent(".session").path))
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: blocked.path)
    try LocalDataReset.erase(directories: [blocked, writable])
    XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: blocked.path).isEmpty)
  }

  func testRemovingCachedSymlinkDoesNotEraseItsTarget() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let cache = root.appendingPathComponent("cache")
    let unrelated = root.appendingPathComponent("unrelated")
    try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: unrelated, withIntermediateDirectories: true)
    let untouched = unrelated.appendingPathComponent("keep")
    try Data("keep".utf8).write(to: untouched)
    try FileManager.default.createSymbolicLink(at: cache.appendingPathComponent("link"), withDestinationURL: unrelated)
    try LocalDataReset.erase(directories: [cache])
    XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: cache.path).isEmpty)
    XCTAssertEqual(try Data(contentsOf: untouched), Data("keep".utf8))
  }
}
