import XCTest

@testable import OpenTeamCore

final class MessagePreviewTests: XCTestCase {
  private struct Previews: Decodable {
    struct Text: Decodable {
      let content: String
      let preview: String
    }
    struct File: Decodable {
      let fileName: String
      let mimeType: String
    }
    struct Attachments: Decodable {
      let files: [File]
      let preview: String
    }
    let messages: [Text]
    let attachments: [Attachments]
  }

  /// Fixture written from packages/contracts by scripts/export-message-previews.ts.
  private func fixture() throws -> Previews {
    let url = Bundle.module.url(
      forResource: "message-previews", withExtension: "json", subdirectory: "Fixtures")!
    return try JSONDecoder().decode(Previews.self, from: Data(contentsOf: url))
  }

  private func asset(_ fileName: String, _ mimeType: String) -> Asset {
    Asset(
      assetId: String(repeating: "a", count: 64), fileName: fileName, mimeType: mimeType,
      byteSize: 42, kind: "file")
  }

  func testTextPreviewsMatchTheSharedContract() throws {
    for example in try fixture().messages {
      // Compare code units: String equality would accept a canonically equivalent result.
      XCTAssertEqual(
        Array(MessagePreview.text(example.content).utf16), Array(example.preview.utf16),
        example.content.debugDescription)
    }
  }

  func testAttachmentPreviewsMatchTheSharedContract() throws {
    for example in try fixture().attachments {
      XCTAssertEqual(
        Array(MessagePreview.attachments(example.files.map { asset($0.fileName, $0.mimeType) }).utf16),
        Array(example.preview.utf16))
    }
  }

  func testLatestMessagePreviewDescribesAttachmentsOnlyWithoutText() throws {
    var message = try Fixture.message()
    let image: JSON = .object([
      "assetId": .string(String(repeating: "a", count: 64)), "fileName": .string("chart.png"),
      "mimeType": .string("image/png"), "kind": .string("image"), "byteSize": .number(42),
    ])
    message.metadata = .object(["attachment": image, "type": .string("attachment")])
    message.content = "chart.png"
    XCTAssertEqual(message.previewText, "Sent 1 image")
    message.metadata = .object(["attachments": .array([image]), "type": .string("text")])
    message.content = ""
    XCTAssertEqual(message.previewText, "Sent 1 image")
    message.content = "Here is the **chart** you asked for."
    XCTAssertEqual(message.previewText, "Here is the chart you asked for.")
    XCTAssertFalse(message.isAttachmentOnly)
    message.content = "chart.png"
    message.metadata = .object(["attachment": image, "type": .string("attachment")])
    XCTAssertTrue(message.isAttachmentOnly)
  }
}
