import Foundation
import XCTest

@testable import OpenTeamCore

final class OnboardingWizardTests: XCTestCase {
  func testStagesAndSteps() {
    XCTAssertEqual(WizardStage.allCases.map(\.title), ["Server", "AI model", "Web search", "Voice", "First bot"])
    XCTAssertEqual(WizardStep.health.stage, .server)
    XCTAssertEqual(
      [WizardStep.choose, .method, .signIn, .apiKey, .test].map(\.stage),
      [.model, .model, .model, .model, .model])
    XCTAssertEqual(WizardStep.search.stage, .search)
    XCTAssertEqual(WizardStep.voice.stage, .voice)
    XCTAssertEqual(WizardStep.bot.stage, .bot)
    XCTAssertEqual(WizardStep.afterModel(searchConfigured: false, voiceConfigured: true), .search)
    XCTAssertEqual(WizardStep.afterModel(searchConfigured: true, voiceConfigured: false), .voice)
    XCTAssertEqual(WizardStep.afterModel(searchConfigured: true, voiceConfigured: true), .bot)
    XCTAssertEqual(WizardStep.afterSearch(voiceConfigured: false), .voice)
  }

  func testGuessesTheProviderFromTheKeyPrefix() {
    XCTAssertEqual(APIKeyProviders.guess("sk-ant-api03-abc"), "anthropic")
    XCTAssertEqual(APIKeyProviders.guess("  sk-or-v1-abc "), "openrouter")
    XCTAssertEqual(APIKeyProviders.guess("sk-proj-abc"), "openai")
    XCTAssertEqual(APIKeyProviders.guess("sk-abc"), "openai")
    XCTAssertEqual(APIKeyProviders.guess("SK-ANT-abc"), "anthropic")
    XCTAssertNil(APIKeyProviders.guess("gsk_abc"))
    XCTAssertNil(APIKeyProviders.guess(""))
    XCTAssertEqual(APIKeyProviders.options.map(\.id), ["openai", "anthropic", "openrouter"])
    XCTAssertEqual(
      APIKeyProviders.options.map(\.keyPage.absoluteString),
      [
        "https://platform.openai.com/api-keys", "https://console.anthropic.com/settings/keys",
        "https://openrouter.ai/keys",
      ])
  }

  func testFirstBotDefaultsAndRequest() throws {
    XCTAssertEqual(FirstBot.names, ["Atlas", "Nova", "Juniper", "Pixel", "Sage", "Orbit"])
    XCTAssertEqual(
      FirstBot.roles.map(\.title),
      ["General helper", "Researcher", "Inbox assistant", "Writer", "Operations"])
    XCTAssertEqual(
      FirstBot.roles.first?.description,
      "Helps with research, writing, and everyday tasks on the web.")
    XCTAssertEqual(
      FirstBot.greeting(name: " Nova ", role: FirstBot.roles[2]),
      "Hi, I'm Nova! I sort email, draft replies for your review, and track follow-ups. What should we start with?"
    )
    XCTAssertTrue(FirstBot.greeting(name: "", role: FirstBot.roles[0]).hasPrefix("Hi! I can help"))
    XCTAssertTrue(FirstBot.names.contains(FirstBot.randomName()))
    XCTAssertEqual(FirstBot.randomName(excluding: ["atlas", "Nova", "Juniper", "Pixel", "Sage"]), "Orbit")
    // The palette leaves out near-black and grey, and every color is a valid bot color.
    XCTAssertFalse(FirstBot.colors.isEmpty)
    for color in FirstBot.colors {
      XCTAssertNotNil(color.range(of: #"^#[0-9a-fA-F]{6}$"#, options: .regularExpression), color)
      XCTAssertFalse(["#242424", "#878787"].contains(color))
    }
    var previous = FirstBot.randomAvatar()
    for _ in 0..<50 {
      let next = FirstBot.randomAvatar(excluding: previous)
      XCTAssertNotNil(RobotShape(rawValue: next.shape))
      XCTAssertNotEqual(next.shape, previous.shape)
      XCTAssertNotEqual(next.color, previous.color)
      previous = next
    }
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
      FirstBot.body(requestId: "request-1234", name: " ", avatar: previous, role: role)["name"]
        .string, "New Bot")
  }
}
