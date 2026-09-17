import XCTest
@testable import OpenTeamCore

final class AttachmentTests: XCTestCase {
  func testLegacyAndArrayAttachmentsPreserveCaptionsAndSkipMalformedEntries() throws {
    let asset: JSON = .object([
      "assetId": .string(String(repeating: "a", count: 64)), "fileName": .string("Photo.png"),
      "mimeType": .string("image/png"), "kind": .string("image"), "byteSize": .number(4200),
      "width": .number(1600), "height": .number(1000), "alt": .string("Caption from the server"),
    ])
    let url = Bundle.module.url(forResource: "bootstrap", withExtension: "json", subdirectory: "Fixtures")!
    var message = try JSONDecoder().decode(Bootstrap.self, from: Data(contentsOf: url)).latestMessages[0]
    message.metadata = .object(["attachment": asset, "attachments": .array([.null, asset]), "type": .string("attachment")])
    message.content = "Photo.png"
    XCTAssertEqual(message.attachments.count, 1)
    XCTAssertEqual(message.attachments[0].alt, "Caption from the server")
    XCTAssertEqual(message.attachments[0].width, 1600)
    XCTAssertEqual(message.displayContent, "")
    let roundTrip = try JSONDecoder().decode(Asset.self, from: JSONEncoder().encode(message.attachments[0]))
    XCTAssertEqual(roundTrip.height, 1000)
    XCTAssertEqual(roundTrip.alt, "Caption from the server")
    message.metadata = .object(["attachment": asset])
    message.content = "A useful photo"
    XCTAssertEqual(message.displayContent, "A useful photo")
    message.metadata = .object(["attachment": asset, "type": .string("attachment")])
    XCTAssertEqual(message.displayContent, "A useful photo")
  }

  func testTemplateExportUsesPortableRecipeWithoutAccountData() throws {
    let url = Bundle.module.url(forResource: "bootstrap", withExtension: "json", subdirectory: "Fixtures")!
    var bot = try JSONDecoder().decode(Bootstrap.self, from: Data(contentsOf: url)).bots[0]
    bot.instructions = "---\nKeep these exact instructions."
    let recipe = BotTemplateExport.recipe(bot: bot, routines: [])
    XCTAssertEqual(recipe["profile"]["name"].string, bot.name)
    XCTAssertEqual(recipe["gettingStarted"]["skill"].string, "Instructions")
    XCTAssertTrue(recipe["skills"].array[0]["content"].string.contains(bot.instructions))
    XCTAssertEqual(recipe["visibility"].string, "team")
    XCTAssertEqual(recipe["memory"].array, [])
    XCTAssertEqual(recipe["plugins"].array, [])
    XCTAssertEqual(recipe["id"], .null)
  }
}
