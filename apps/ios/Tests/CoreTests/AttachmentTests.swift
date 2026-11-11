import XCTest

@testable import OpenTeamCore

final class AttachmentTests: XCTestCase {
  func testAttachmentLimitsMatchServerAtBoundaries() throws {
    let mb = 1024 * 1024
    for mime in ["application/pdf", "image/png", "audio/mpeg"] {
      XCTAssertNoThrow(try AttachmentLimits.validate(byteCount: 25 * mb, mimeType: mime))
      XCTAssertThrowsError(try AttachmentLimits.validate(byteCount: 25 * mb + 1, mimeType: mime))
    }
    XCTAssertNoThrow(try AttachmentLimits.validate(byteCount: 200 * mb, mimeType: "video/mp4"))
    XCTAssertThrowsError(
      try AttachmentLimits.validate(byteCount: 200 * mb + 1, mimeType: "video/mp4"))
    XCTAssertThrowsError(try AttachmentLimits.validate(byteCount: 0, mimeType: "video/mp4"))
  }

  func testArrayAttachmentsPreserveCaptionsAndSkipMalformedEntries() throws {
    let asset: JSON = .object([
      "assetId": .string(String(repeating: "a", count: 64)), "fileName": .string("Photo.png"),
      "mimeType": .string("image/png"), "kind": .string("image"), "byteSize": .number(4200),
      "width": .number(1600), "height": .number(1000), "alt": .string("Caption from the server"),
    ])
    let url = Bundle.module.url(
      forResource: "bootstrap", withExtension: "json", subdirectory: "Fixtures")!
    var message = try JSONDecoder().decode(Bootstrap.self, from: Data(contentsOf: url))
      .latestMessages[0]
    message.metadata = .object([
      "attachments": .array([.null, asset]), "type": .string("attachment"),
    ])
    message.content = "Photo.png"
    XCTAssertEqual(message.attachments.count, 1)
    XCTAssertEqual(message.attachments[0].alt, "Caption from the server")
    XCTAssertEqual(message.attachments[0].width, 1600)
    XCTAssertEqual(message.displayContent, "")
    let roundTrip = try JSONDecoder().decode(
      Asset.self, from: JSONEncoder().encode(message.attachments[0]))
    XCTAssertEqual(roundTrip.height, 1000)
    XCTAssertEqual(roundTrip.alt, "Caption from the server")
    message.metadata = .object(["attachments": .array([asset])])
    message.content = "A useful photo"
    XCTAssertEqual(message.displayContent, "A useful photo")
    message.metadata = .object(["attachments": .array([asset]), "type": .string("attachment")])
    XCTAssertEqual(message.displayContent, "A useful photo")
  }

  func testTemplateExportUsesPortableRecipeWithoutAccountData() throws {
    let url = Bundle.module.url(
      forResource: "bootstrap", withExtension: "json", subdirectory: "Fixtures")!
    let bot = try JSONDecoder().decode(Bootstrap.self, from: Data(contentsOf: url)).bots[0]
    let recipe = BotTemplateExport.recipe(bot: bot, routines: [])
    XCTAssertEqual(recipe["profile"]["name"].string, bot.name)
    XCTAssertEqual(recipe["gettingStarted"], .null)
    XCTAssertEqual(recipe["skills"].array, [])
    XCTAssertEqual(recipe["visibility"].string, "team")
    XCTAssertEqual(recipe["memory"].array, [])
    XCTAssertEqual(recipe["plugins"].array, [])
    XCTAssertEqual(recipe["id"], .null)
  }

  func testBotCacheDropsRetiredInstructionsFieldWhenReencoded() throws {
    let url = Bundle.module.url(
      forResource: "bootstrap", withExtension: "json", subdirectory: "Fixtures")!
    let bot = try JSONDecoder().decode(Bootstrap.self, from: Data(contentsOf: url)).bots[0]
    var legacy = try JSONSerialization.jsonObject(with: JSONEncoder().encode(bot)) as! [String: Any]
    legacy["instructions"] = "Retired legacy guidance"
    let restored = try JSONDecoder().decode(Bot.self, from: JSONSerialization.data(withJSONObject: legacy))
    let saved = try JSONSerialization.jsonObject(with: JSONEncoder().encode(restored)) as! [String: Any]
    XCTAssertNil(saved["instructions"])
    XCTAssertEqual(saved["title"] as? String, bot.title)
    XCTAssertEqual(saved["description"] as? String, bot.description)
  }

}
