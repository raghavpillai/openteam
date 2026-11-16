import Foundation
import XCTest

@testable import OpenTeamCore

final class OnboardingWizardTests: XCTestCase {

  func testFirstBotDefaultsAndRequest() throws {
    XCTAssertEqual(FirstBot.randomName(excluding: ["atlas", "Nova", "Juniper", "Pixel", "Sage"]), "Orbit")
    let role = try XCTUnwrap(FirstBot.roles.first { $0.id == "inbox" })
    let body = FirstBot.body(
      requestId: "request-1234", name: "  Nova ", avatar: .init(shape: "tv-head", color: "#4B8EFB"),
      role: role)
    XCTAssertEqual(
      body,
      .object([
        "clientRequestId": .string("request-1234"), "name": .string("Nova"),
        "icon": .string("tv-head"), "color": .string("#4b8efb"),
        "description": .string(
          "Sorts email, drafts replies for your review, and tracks follow-ups."),
      ]))
    XCTAssertEqual(
      FirstBot.body(requestId: "request-1234", name: " ", avatar: .init(shape: "tv-head", color: "#4B8EFB"), role: role)["name"]
        .string, "New Bot")
  }
}
